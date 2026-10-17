// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlockPulseMarket} from "../src/BlockPulseMarket.sol";

interface Vm {
    function warp(uint256) external;
    function roll(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function setBlockhash(uint256, bytes32) external;
    function expectRevert(bytes4) external;
}

contract Trader {
    receive() external payable {}
}

contract BlockPulseMarketTest {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint64 private constant DELAY = 190;
    BlockPulseMarket private market;
    address private alice = address(new Trader());
    address private bob = address(new Trader());

    receive() external payable {}

    function setUp() public {
        VM.warp(1_800_000_000);
        VM.roll(1_000);
        VM.deal(address(this), 100 ether);
        VM.deal(alice, 10 ether);
        VM.deal(bob, 10 ether);
        market = new BlockPulseMarket{value: 1 ether}(DELAY);
    }

    function eq(uint256 a, uint256 b, string memory why) private pure {
        require(a == b, why);
    }

    function near(uint256 a, uint256 b, uint256 tolerance, string memory why) private pure {
        require(a > b ? a - b <= tolerance : b - a <= tolerance, why);
    }

    function solvent() private view {
        eq(address(market).balance, market.houseCash() + market.unclaimed(), "balance must equal house cash plus unclaimed");
    }

    function finishRound(bytes32 seed) private {
        (uint256[31] memory s) = market.snapshot(address(0));
        VM.warp(s[1] + 60);
        VM.roll(s[2] + 1);
        VM.setBlockhash(s[2], seed);
        market.settle();
    }

    function testRoundStartsWithEvenPricesAndCappedLiquidity() public {
        market.startRound();
        uint256[31] memory s = market.snapshot(alice);
        eq(s[0], 1, "round id");
        eq(s[3], 150e18, "liquidity capped");
        eq(s[2], block.number + DELAY, "random block");
        eq(s[4], 100, "heat");
        near(s[12] + s[13] + s[14], 1e18, 2, "prices sum to one");
        near(s[12], 333333333333333333, 2, "even red price");
    }

    function testBuyCostMatchesLmsrAndRefundsChange() public {
        market.startRound();
        (uint256 gross, uint256 fee, uint256 total,, bool ok) = market.quote(0, true, 100);
        // 150 * ln(exp(100 / 150) + 2) - 150 * ln(3) = 41.17941977... shares of 0.001 MON.
        near(gross, 41179419771944712, 1e6, "LMSR buy cost");
        eq(fee, (gross * 30 + 9999) / 10000, "fee");
        require(ok, "quote solvent");
        uint256 before = alice.balance;
        VM.prank(alice);
        market.buy{value: 1 ether}(0, 100);
        eq(before - alice.balance, total, "only the quoted total is kept");
        uint256[31] memory s = market.snapshot(alice);
        eq(s[20], 100, "holdings");
        eq(s[25], total, "basis");
        require(s[12] > 333333333333333334, "red price rises");
        solvent();
    }

    function testBuyThenSellNeverProfits() public {
        market.startRound();
        uint256 start = alice.balance;
        for (uint256 shares = 1; shares <= 1000; shares = shares * 3 + 1) {
            VM.prank(alice);
            market.buy{value: 2 ether}(2, shares);
            VM.prank(alice);
            market.sell(2, shares, 0);
        }
        require(alice.balance < start, "round trip loses fees");
        solvent();
    }

    function testUnderpaymentAndShortSellingRevert() public {
        market.startRound();
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.InsufficientPayment.selector);
        market.buy{value: 1}(0, 10);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.InsufficientHoldings.selector);
        market.sell(0, 1, 0);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.InvalidShares.selector);
        market.buy{value: 1 ether}(0, 1001);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.InvalidColor.selector);
        market.buy{value: 1 ether}(3, 1);
    }

    function testSellSlippageGuard() public {
        market.startRound();
        VM.prank(alice);
        market.buy{value: 1 ether}(1, 50);
        (,, uint256 total,,) = market.quote(1, false, 50);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.SlippageExceeded.selector);
        market.sell(1, 50, total + 1);
        VM.prank(alice);
        market.sell(1, 50, total);
        eq(market.snapshot(alice)[21], 0, "sold out");
    }

    function testTradingClosesByTimeOrRandomBlock() public {
        market.startRound();
        VM.warp(block.timestamp + 55);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.MarketClosed.selector);
        market.buy{value: 1 ether}(0, 1);
        VM.warp(block.timestamp - 10);
        VM.roll(block.number + DELAY);
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.MarketClosed.selector);
        market.act(true);
    }

    function testTicketsAndHeatLimits() public {
        market.startRound();
        for (uint256 i; i < 3; ++i) {
            VM.prank(alice);
            market.act(true);
        }
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.NoTickets.selector);
        market.act(true);
        eq(market.snapshot(alice)[4], 103, "heat moved three steps");
        eq(market.snapshot(alice)[23], 3, "tickets used");
        for (uint256 i; i < 6; ++i) {
            address user = address(uint160(0x1000 + i));
            VM.prank(user);
            market.act(true);
        }
        VM.prank(address(0x2000));
        VM.expectRevert(BlockPulseMarket.HeatLimit.selector);
        market.act(true);
    }

    function testSettlementPaysWinnersAndKeepsLedgerBalanced() public {
        market.startRound();
        VM.prank(alice);
        market.buy{value: 1 ether}(0, 120);
        VM.prank(bob);
        market.buy{value: 1 ether}(1, 80);
        VM.prank(alice);
        market.buy{value: 1 ether}(2, 40);
        VM.expectRevert(BlockPulseMarket.RoundNotReady.selector);
        market.settle();
        finishRound(keccak256("seed"));
        uint256[31] memory s = market.snapshot(alice);
        eq(s[5], 1, "settled");
        uint8 result = uint8(s[6]);
        int256 finalHeat = int256(s[7]);
        require(finalHeat >= 88 && finalHeat <= 112, "noise in range");
        uint256 expected = [uint256(120), 80, 40][result] * 1e15;
        eq(market.unclaimed(), expected, "liability moved to unclaimed");
        eq(s[12 + result], 1e18, "winner pays one");
        solvent();
        address winner = result == 1 ? bob : alice;
        uint256 before = winner.balance;
        VM.prank(winner);
        market.claim();
        eq(winner.balance - before, expected, "claim pays winning shares");
        VM.prank(winner);
        VM.expectRevert(BlockPulseMarket.NothingToClaim.selector);
        market.claim();
        solvent();
    }

    function testClaimSettlesReadyRoundAndRolloverCreditsNextRound() public {
        market.startRound();
        VM.prank(alice);
        market.buy{value: 1 ether}(0, 30);
        VM.prank(alice);
        market.buy{value: 1 ether}(1, 30);
        VM.prank(alice);
        market.buy{value: 1 ether}(2, 30);
        uint256[31] memory s = market.snapshot(alice);
        VM.warp(s[1] + 60);
        VM.roll(s[2] + 1);
        VM.setBlockhash(s[2], bytes32(uint256(7)));
        market.startRound();
        eq(market.currentRound(), 2, "next round opened after settlement");
        eq(market.claimable(alice), 30e15, "previous winnings are claimable");
        VM.prank(alice);
        market.act(false);
        eq(market.credit(alice), 30e15, "rollover credits previous round");
        uint256 before = alice.balance;
        VM.prank(alice);
        market.claim();
        eq(alice.balance - before, 30e15, "credit paid");
        solvent();
    }

    function testExpiredBlockhashRearmsInsteadOfSettling() public {
        market.startRound();
        uint256[31] memory s = market.snapshot(alice);
        VM.warp(s[1] + 60);
        VM.roll(s[2] + 300);
        market.settle();
        s = market.snapshot(alice);
        eq(s[5], 0, "not settled");
        eq(s[2], block.number + 1, "re-armed to next block");
        VM.expectRevert(BlockPulseMarket.RoundNotReady.selector);
        market.startRound();
        VM.roll(block.number + 2);
        VM.setBlockhash(s[2], bytes32(uint256(9)));
        market.startRound();
        eq(market.currentRound(), 2, "settled and started");
    }

    function testReserveBoundsLiquiditySoMaxBuysStayCovered() public {
        BlockPulseMarket small = new BlockPulseMarket{value: 0.05 ether}(DELAY);
        small.startRound();
        uint256[31] memory s = small.snapshot(alice);
        near(s[3], uint256(0.05 ether) * 1000 * 8 / 10 * 1e18 / 1098612288668109691, 1, "liquidity follows reserve");
        for (uint256 i; i < 3; ++i) {
            VM.prank(alice);
            small.buy{value: 2 ether}(0, 1000);
        }
        require(small.houseCash() >= 3000e15, "house covers the largest payout");
        (,,,, bool ok) = small.quote(0, true, 1000);
        require(ok, "LMSR keeps further buys covered");
        BlockPulseMarket tiny = new BlockPulseMarket{value: 0.001 ether}(DELAY);
        VM.expectRevert(BlockPulseMarket.HouseTooSmall.selector);
        tiny.startRound();
    }

    function testOwnerControlsHouseOnlyBetweenRounds() public {
        VM.prank(alice);
        VM.expectRevert(BlockPulseMarket.NotOwner.selector);
        market.withdrawHouse(1);
        VM.prank(alice);
        market.fund{value: 0.5 ether}();
        eq(market.houseCash(), 1.5 ether, "anyone can fund");
        market.startRound();
        VM.expectRevert(BlockPulseMarket.RoundActive.selector);
        market.withdrawHouse(1);
        finishRound(bytes32(uint256(3)));
        uint256 before = address(this).balance;
        market.withdrawHouse(0.4 ether);
        eq(address(this).balance - before, 0.4 ether, "owner withdrew");
        VM.expectRevert(BlockPulseMarket.InvalidDelay.selector);
        market.setRandomDelay(5);
        market.setRandomDelay(60);
        eq(market.randomDelay(), 60, "delay updated");
        solvent();
    }

    function testManyTradersStayCovered() public {
        market.startRound();
        for (uint256 i; i < 40; ++i) {
            address user = address(uint160(0x5000 + i));
            VM.deal(user, 5 ether);
            VM.prank(user);
            try market.buy{value: 5 ether}(uint8(i % 3), 37 + i * 11) {} catch {}
            if (i % 4 == 0) {
                uint256 owned = market.snapshot(user)[20 + i % 3];
                if (owned > 0) {
                    VM.prank(user);
                    market.sell(uint8(i % 3), owned / 2 + 1, 0);
                }
            }
        }
        uint256[31] memory s = market.snapshot(alice);
        uint256 top = s[9] > s[10] ? s[9] : s[10];
        if (s[11] > top) top = s[11];
        require(market.houseCash() >= top * 1e15, "house covers every outcome");
        near(s[12] + s[13] + s[14], 1e18, 3, "prices sum to one");
        finishRound(bytes32(uint256(11)));
        solvent();
    }
}
