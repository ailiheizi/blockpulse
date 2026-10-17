#!/bin/zsh
# 本地试玩启动器：不安装、不上传，只监听本机 127.0.0.1:4173。
set -u

project_dir="$(cd "$(dirname "$0")" && pwd -P)" || exit 1
cd "$project_dir" || exit 1
local_url="http://127.0.0.1:4173"

stop_with_message() {
  print -u2 -- "\n$1"
  read -r "?按回车关闭此窗口……"
  exit 1
}

print -- "BlockPulse · 本地试玩"
print -- "项目目录：$project_dir"
print -- "试玩地址：$local_url"

if [[ ! -f "$project_dir/server.mjs" || ! -f "$project_dir/dist/index.html" ]]; then
  stop_with_message "找不到本地服务或网页文件。请把启动器留在 blockpulse-demo 项目目录内。"
fi

# 显式绕过代理；所有探测都只访问回环地址。
existing_page="$(/usr/bin/curl --noproxy '*' -fsS --max-time 2 "$local_url" 2>/dev/null)"
if [[ "$existing_page" == *'<title>BlockPulse'* ]]; then
  print -- "本地试玩已在运行，直接打开浏览器；不会另起服务或占用端口。"
  /usr/bin/open "$local_url" || stop_with_message "浏览器未能自动打开，请手动访问 $local_url。"
  print -- "请保留原来运行服务的终端窗口。这个窗口可以关闭。"
  exit 0
elif [[ -n "$existing_page" ]]; then
  stop_with_message "4173 端口已有其他网页服务。为避免打断它，本启动器没有关闭任何进程；请检查该端口后重试。"
fi

node_bin=""
system_node="$(command -v node 2>/dev/null || true)"
for candidate in "$system_node" \
  "/Users/macos/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
  "/opt/homebrew/bin/node" "/usr/local/bin/node"; do
  if [[ -n "$candidate" && -x "$candidate" ]] && \
    "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    node_bin="$candidate"
    break
  fi
done

if [[ -z "$node_bin" ]]; then
  stop_with_message "没有找到可用的 Node.js 18 或更新版本（也未找到本机已有的 Codex 运行时）。启动器不会联网安装；请在有可用 Node.js 的终端内重试。"
fi

print -- "使用 Node.js：$node_bin"
print -- "正在启动。请保持这个终端窗口打开；退出试玩后按 Control+C 停止本服务。"

# 浏览器等待服务就绪；Node 服务本身始终在前台运行。
(
  for attempt in {1..40}; do
    ready_page="$(/usr/bin/curl --noproxy '*' -fsS --max-time 1 "$local_url" 2>/dev/null)"
    if [[ "$ready_page" == *'<title>BlockPulse'* ]]; then
      /usr/bin/open "$local_url" || print -u2 -- "请手动在浏览器打开 $local_url。"
      exit 0
    fi
    /bin/sleep 0.25
  done
  print -u2 -- "浏览器尚未自动打开。请查看服务日志，并手动访问 $local_url。"
) &

PORT=4173 "$node_bin" "$project_dir/server.mjs"
server_exit=$?
if (( server_exit != 0 && server_exit != 130 )); then
  stop_with_message "本地服务未能启动（退出码 $server_exit）。请查看上方日志；若端口已被占用，本启动器不会停止占用它的进程。"
fi

print -- "本地服务已停止。再次双击“启动试玩.command”即可重新打开。"
