// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title BlockPulseMarket
/// @notice Shared three-outcome LMSR market paid in native testnet MON.
/// Settlement noise comes from the hash of a block fixed at round start, which
/// block producers can influence. This is demo-grade randomness for testnet play.
contract BlockPulseMarket {
    uint256 public constant SHARE_WEI = 1e15;
    uint256 public constant TRADING_SECONDS = 55;
    uint256 public constant ROUND_SECONDS = 60;
    uint256 public constant FEE_BPS = 30;
    uint256 public constant MAX_SHARES = 1000;
    uint256 public constant TICKETS = 3;
    int64 public constant BASE_HEAT = 100;
    int64 public constant MAX_HEAT_SHIFT = 9;
    int64 public constant NOISE_RANGE = 12;
    uint256 public constant MAX_LIQUIDITY = 150e18;
    uint256 public constant MIN_HOUSE_CASH = 2e16;
    uint64 public constant MIN_DELAY = 20;
    uint64 public constant MAX_DELAY = 2000;

    uint256 private constant WAD = 1e18;
    uint256 private constant LN2 = 693147180559945309;
    uint256 private constant LN3 = 1098612288668109691;

    struct Round {
        uint64 startTime;
        uint64 randomBlock;
        uint128 liquidity;
        int64 heat;
        int64 finalHeat;
        uint8 result;
        bool settled;
        uint32 trades;
        uint64 startBlock;
        uint256[3] q;
    }

    address public owner;
    uint64 public randomDelay;
    uint256 public houseCash;
    uint256 public unclaimed;
    uint256 public currentRound;
    bool private entered;

    mapping(uint256 => Round) private rounds;
    mapping(uint256 => mapping(address => uint256[3])) private holdings;
    mapping(uint256 => mapping(address => uint256[3])) private basis;
    mapping(uint256 => mapping(address => uint256)) private ticketsUsed;
    mapping(address => uint256) public lastRound;
    mapping(address => uint256) public credit;

    event Funded(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event RoundStarted(uint256 indexed round, uint256 startTime, uint256 randomBlock, uint256 liquidity);
    event Trade(uint256 indexed round, address indexed trader, uint8 color, bool isBuy, uint256 shares, uint256 total, uint256 fee);
    event Action(uint256 indexed round, address indexed trader, int256 delta, int256 heat);
    event SettlementRearmed(uint256 indexed round, uint256 randomBlock);
    event Settled(uint256 indexed round, uint8 result, int256 finalHeat, int256 noise, uint256 payout);
    event Claimed(address indexed user, uint256 amount);

    error NotOwner();
    error Reentrancy();
    error InvalidDelay();
    error RoundActive();
    error RoundNotReady();
    error MarketClosed();
    error InvalidColor();
    error InvalidShares();
    error InsufficientPayment();
    error InsufficientHoldings();
    error InsufficientReserve();
    error SlippageExceeded();
    error NoTickets();
    error HeatLimit();
    error HouseTooSmall();
    error NothingToClaim();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor(uint64 delay) payable {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert InvalidDelay();
        owner = msg.sender;
        randomDelay = delay;
        houseCash = msg.value;
        emit Funded(msg.sender, msg.value);
    }

    receive() external payable {
        fund();
    }

    function fund() public payable {
        houseCash += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    function withdrawHouse(uint256 amount) external onlyOwner nonReentrant {
        uint256 id = currentRound;
        if (id != 0 && !rounds[id].settled) revert RoundActive();
        if (amount > houseCash) revert InsufficientReserve();
        houseCash -= amount;
        _send(owner, amount);
        emit Withdrawn(owner, amount);
    }

    /// @dev Applies to rounds started after the change.
    function setRandomDelay(uint64 delay) external onlyOwner {
        if (delay < MIN_DELAY || delay > MAX_DELAY) revert InvalidDelay();
        randomDelay = delay;
    }

    /// @notice Settles the previous round when needed, then opens a new one.
    /// Returns without starting when the previous settlement had to be re-armed.
    function startRound() external {
        uint256 id = currentRound;
        if (id != 0 && !rounds[id].settled && !_settle(id)) return;
        if (houseCash < MIN_HOUSE_CASH) revert HouseTooSmall();
        uint256 b = _nextLiquidity();
        id += 1;
        currentRound = id;
        Round storage r = rounds[id];
        r.startTime = uint64(block.timestamp);
        r.startBlock = uint64(block.number);
        r.randomBlock = uint64(block.number + randomDelay);
        r.liquidity = uint128(b);
        r.heat = BASE_HEAT;
        emit RoundStarted(id, block.timestamp, r.randomBlock, b);
    }

    function settle() external {
        uint256 id = currentRound;
        if (id == 0 || rounds[id].settled) revert RoundNotReady();
        _settle(id);
    }

    function buy(uint8 color, uint256 shares) external payable nonReentrant {
        (uint256 id, Round storage r) = _openRound();
        _checkOrder(color, shares);
        _rollover(msg.sender, id);
        uint256[3] memory next = r.q;
        next[color] += shares;
        (, uint256 fee, uint256 total) = _amounts(r.q, next, r.liquidity, true);
        if (msg.value < total) revert InsufficientPayment();
        if (houseCash + total < _maxShares(next) * SHARE_WEI) revert InsufficientReserve();
        houseCash += total;
        r.q[color] = next[color];
        r.trades += 1;
        holdings[id][msg.sender][color] += shares;
        basis[id][msg.sender][color] += total;
        emit Trade(id, msg.sender, color, true, shares, total, fee);
        if (msg.value > total) _send(msg.sender, msg.value - total);
    }

    function sell(uint8 color, uint256 shares, uint256 minProceeds) external nonReentrant {
        (uint256 id, Round storage r) = _openRound();
        _checkOrder(color, shares);
        _rollover(msg.sender, id);
        uint256 owned = holdings[id][msg.sender][color];
        if (owned < shares) revert InsufficientHoldings();
        uint256[3] memory next = r.q;
        next[color] -= shares;
        (, uint256 fee, uint256 total) = _amounts(r.q, next, r.liquidity, false);
        if (total < minProceeds) revert SlippageExceeded();
        if (houseCash < total || houseCash - total < _maxShares(next) * SHARE_WEI) revert InsufficientReserve();
        uint256 paid = basis[id][msg.sender][color];
        basis[id][msg.sender][color] = paid - (owned == shares ? paid : paid * shares / owned);
        holdings[id][msg.sender][color] = owned - shares;
        houseCash -= total;
        r.q[color] = next[color];
        r.trades += 1;
        emit Trade(id, msg.sender, color, false, shares, total, fee);
        _send(msg.sender, total);
    }

    function act(bool heatUp) external {
        (uint256 id, Round storage r) = _openRound();
        _rollover(msg.sender, id);
        if (ticketsUsed[id][msg.sender] >= TICKETS) revert NoTickets();
        int64 heat = r.heat + (heatUp ? int64(1) : int64(-1));
        if (heat > BASE_HEAT + MAX_HEAT_SHIFT || heat < BASE_HEAT - MAX_HEAT_SHIFT) revert HeatLimit();
        ticketsUsed[id][msg.sender] += 1;
        r.heat = heat;
        emit Action(id, msg.sender, heatUp ? int256(1) : int256(-1), heat);
    }

    /// @notice Pays credited and newly settled winnings, settling the current round first when its block hash is ready.
    function claim() external nonReentrant {
        uint256 id = currentRound;
        Round storage current = rounds[id];
        if (id != 0 && !current.settled && _settleReady(current) && blockhash(current.randomBlock) != bytes32(0)) _settle(id);
        uint256 amount = credit[msg.sender];
        uint256 last = lastRound[msg.sender];
        if (last != 0 && rounds[last].settled) {
            amount += holdings[last][msg.sender][rounds[last].result] * SHARE_WEI;
            lastRound[msg.sender] = 0;
        }
        if (amount == 0) revert NothingToClaim();
        credit[msg.sender] = 0;
        unclaimed -= amount;
        _send(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    function quote(uint8 color, bool isBuy, uint256 shares)
        external
        view
        returns (uint256 gross, uint256 fee, uint256 total, uint256 priceAfter, bool solvent)
    {
        _checkOrder(color, shares);
        Round storage r = rounds[currentRound];
        bool open = currentRound != 0 && !r.settled;
        uint256[3] memory q = open ? r.q : [uint256(0), 0, 0];
        uint256 b = open ? r.liquidity : _nextLiquidity();
        if (b == 0 || (!isBuy && q[color] < shares)) return (0, 0, 0, 0, false);
        uint256[3] memory next = [q[0], q[1], q[2]];
        if (isBuy) next[color] += shares;
        else next[color] -= shares;
        (gross, fee, total) = _amounts(q, next, b, isBuy);
        priceAfter = _prices(next, b)[color];
        uint256 need = _maxShares(next) * SHARE_WEI;
        solvent = isBuy ? houseCash + total >= need : houseCash >= total && houseCash - total >= need;
    }

    /// @notice Packed view for the UI. Layout:
    /// 0 round, 1 startTime, 2 randomBlock, 3 liquidity, 4 heat, 5 settled, 6 result, 7 finalHeat,
    /// 8 trades, 9-11 q, 12-14 prices, 15 houseCash, 16 unclaimed, 17 randomDelay, 18 block number,
    /// 19 timestamp, 20-22 user holdings, 23 user tickets used, 24 user claimable, 25-27 user basis,
    /// 28 owner, 29 next liquidity, 30 startBlock. Signed fields use two's complement.
    function snapshot(address user) external view returns (uint256[31] memory s) {
        uint256 id = currentRound;
        Round storage r = rounds[id];
        s[0] = id;
        s[1] = r.startTime;
        s[2] = r.randomBlock;
        s[3] = r.liquidity;
        s[4] = uint256(int256(r.heat));
        s[5] = r.settled ? 1 : 0;
        s[6] = r.result;
        s[7] = uint256(int256(r.finalHeat));
        s[8] = r.trades;
        uint256[3] memory p;
        if (id == 0) p = [uint256(333333333333333333), 333333333333333333, 333333333333333334];
        else if (r.settled) p[r.result] = WAD;
        else p = _prices(r.q, r.liquidity);
        for (uint256 i; i < 3; ++i) {
            s[9 + i] = r.q[i];
            s[12 + i] = p[i];
            s[20 + i] = holdings[id][user][i];
            s[25 + i] = basis[id][user][i];
        }
        s[15] = houseCash;
        s[16] = unclaimed;
        s[17] = randomDelay;
        s[18] = block.number;
        s[19] = block.timestamp;
        s[23] = ticketsUsed[id][user];
        s[24] = claimable(user);
        s[28] = uint256(uint160(owner));
        s[29] = _nextLiquidity();
        s[30] = r.startBlock;
    }

    function claimable(address user) public view returns (uint256 amount) {
        amount = credit[user];
        uint256 last = lastRound[user];
        if (last != 0 && rounds[last].settled) amount += holdings[last][user][rounds[last].result] * SHARE_WEI;
    }

    function _openRound() private view returns (uint256 id, Round storage r) {
        id = currentRound;
        r = rounds[id];
        if (id == 0 || r.settled || block.timestamp >= r.startTime + TRADING_SECONDS || block.number >= r.randomBlock) {
            revert MarketClosed();
        }
    }

    function _settleReady(Round storage r) private view returns (bool) {
        return block.timestamp >= r.startTime + ROUND_SECONDS && block.number > r.randomBlock;
    }

    /// @dev Returns false after re-arming when the committed block hash is older than 256 blocks.
    function _settle(uint256 id) private returns (bool) {
        Round storage r = rounds[id];
        if (!_settleReady(r)) revert RoundNotReady();
        bytes32 seed = blockhash(r.randomBlock);
        if (seed == bytes32(0)) {
            r.randomBlock = uint64(block.number + 1);
            emit SettlementRearmed(id, r.randomBlock);
            return false;
        }
        uint256 span = uint256(int256(2 * NOISE_RANGE + 1));
        int64 noise = int64(int256(uint256(keccak256(abi.encode(seed, id, address(this)))) % span)) - NOISE_RANGE;
        int64 finalHeat = r.heat + noise;
        uint8 result = finalHeat > BASE_HEAT + 2 ? 0 : finalHeat < BASE_HEAT - 2 ? 1 : 2;
        uint256 payout = r.q[result] * SHARE_WEI;
        houseCash -= payout;
        unclaimed += payout;
        r.finalHeat = finalHeat;
        r.result = result;
        r.settled = true;
        emit Settled(id, result, finalHeat, noise, payout);
        return true;
    }

    function _rollover(address user, uint256 id) private {
        uint256 last = lastRound[user];
        if (last == id) return;
        if (last != 0 && rounds[last].settled) {
            credit[user] += holdings[last][user][rounds[last].result] * SHARE_WEI;
        }
        lastRound[user] = id;
    }

    function _checkOrder(uint8 color, uint256 shares) private pure {
        if (color > 2) revert InvalidColor();
        if (shares == 0 || shares > MAX_SHARES) revert InvalidShares();
    }

    function _nextLiquidity() private view returns (uint256 b) {
        b = houseCash * (WAD / SHARE_WEI) * 8 / 10 * WAD / LN3;
        if (b > MAX_LIQUIDITY) b = MAX_LIQUIDITY;
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Rounds against the trader by one wei on top of truncation, so a buy then sell never profits.
    function _amounts(uint256[3] memory before, uint256[3] memory next, uint256 b, bool isBuy)
        private
        pure
        returns (uint256 gross, uint256 fee, uint256 total)
    {
        uint256 unit = WAD / SHARE_WEI;
        if (isBuy) {
            gross = (_cost(next, b) - _cost(before, b)) / unit + 1;
            fee = (gross * FEE_BPS + 9999) / 10000;
            total = gross + fee;
        } else {
            uint256 raw = (_cost(before, b) - _cost(next, b)) / unit;
            gross = raw > 0 ? raw - 1 : 0;
            fee = (gross * FEE_BPS + 9999) / 10000;
            total = gross > fee ? gross - fee : 0;
        }
    }

    function _maxShares(uint256[3] memory q) private pure returns (uint256 top) {
        top = q[0];
        if (q[1] > top) top = q[1];
        if (q[2] > top) top = q[2];
    }

    /// @dev LMSR cost in wad shares: max(q) + b * ln(sum(exp((q_i - max(q)) / b))).
    function _cost(uint256[3] memory q, uint256 b) private pure returns (uint256) {
        uint256 top = _maxShares(q);
        uint256 sum;
        for (uint256 i; i < 3; ++i) sum += _expNeg((top - q[i]) * WAD * WAD / b);
        return top * WAD + b * _ln(sum) / WAD;
    }

    function _prices(uint256[3] memory q, uint256 b) private pure returns (uint256[3] memory p) {
        uint256 top = _maxShares(q);
        uint256[3] memory e;
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            e[i] = _expNeg((top - q[i]) * WAD * WAD / b);
            sum += e[i];
        }
        for (uint256 i; i < 3; ++i) p[i] = e[i] * WAD / sum;
    }

    /// @dev exp(-x) for wad x >= 0, via exp(-x) = 2^-k / exp(r) with r in [0, ln2).
    function _expNeg(uint256 x) private pure returns (uint256) {
        if (x >= 42 * WAD) return 0;
        uint256 k = x / LN2;
        uint256 r = x - k * LN2;
        uint256 term = WAD;
        uint256 sum = WAD;
        for (uint256 i = 1; term != 0; ++i) {
            term = term * r / (i * WAD);
            sum += term;
        }
        return (WAD * WAD / sum) >> k;
    }

    /// @dev ln(y) for wad y >= 1, via ln(m) = 2 atanh((m - 1) / (m + 1)) after halving into [1, 2).
    function _ln(uint256 y) private pure returns (uint256 result) {
        while (y >= 2 * WAD) {
            y /= 2;
            result += LN2;
        }
        uint256 z = (y - WAD) * WAD / (y + WAD);
        uint256 z2 = z * z / WAD;
        uint256 term = z;
        uint256 series;
        for (uint256 i = 1; term != 0; i += 2) {
            series += term / i;
            term = term * z2 / WAD;
        }
        result += 2 * series;
    }
}
