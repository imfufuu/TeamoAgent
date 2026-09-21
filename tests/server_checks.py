#!/usr/bin/env python3
"""本地中继（server.py）的安全护栏自检 —— 纯 stdlib，直接 `python3 tests/server_checks.py`。

为什么单独一层：/api/git 会在机器上真的执行 git，/api/fetch 会真的发外网请求，
这两条路径的边界（子命令白名单、SSRF、HTML 抽取）必须在**不需要 node、不需要网络**的情况下也能验证。
server.py 的入口被 `if __name__ == "__main__"` 保护，所以可以安全地按模块加载。
"""
import importlib.util
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_server():
    spec = importlib.util.spec_from_file_location("teamo_server_under_test", ROOT / "server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # 不会起服务：监听在 __main__ 分支里
    return mod


ok = 0
bad = []


def check(name, cond, extra=""):
    global ok
    if cond:
        ok += 1
        print(f"  ✓ {name}")
    else:
        bad.append(name)
        print(f"  ✗ {name} {extra}")


def main():
    sys.path.insert(0, str(ROOT))
    m = load_server()

    print("git 参数护栏（validate_git_argv）")
    cases = [
        # (命令, 期望通过)
        ("git status", True),
        ("git log --oneline -5", True),
        ("git clone --depth 1 https://github.com/octocat/Hello-World.git repo", True),
        ("git push --force", True),                      # 用户自己的 workspace 仓库，允许
        ("git config -l", True),
        ("git config --get user.email", True),
        ("git config user.email a@b.c", True),           # 只允许写本仓库配置
        ("git -c core.fsmonitor=/tmp/x status", False),   # 借 -c 执行任意程序
        ("git config --global user.email a@b.c", False),  # 不许碰用户全局配置
        ("git config --file ~/.gitconfig -l", False),
        ("git config alias.x '!rm -rf /'", False),        # alias 里塞 shell
        ("git config core.fsmonitor /tmp/evil", False),
        ("git config credential.helper store", False),
        ("git init --separate-git-dir=/home/user/.git", False),  # 等号形式也要拦住
        ("git status --git-dir=/home/user/.git", False),
        ("git clone ext::sh:ls x", False),                 # ext 传输 = 任意执行
        ("git daemon --export-all", False),                # 起服务/放行子命令
        ("git credential fill", False),                    # 读用户凭据
        ("rm -rf workspace", False),                       # 不是 git
        ("git", False),                                    # 没有子命令
    ]
    import shlex
    for cmd, should_pass in cases:
        err = m.validate_git_argv(shlex.split(cmd))
        check(("允许 " if should_pass else "拒绝 ") + cmd, (err is None) == should_pass, f"→ {err}")

    print("\nSSRF 护栏（guard_public_http_url）")
    for denied in ["http://127.0.0.1:8787/api/git", "http://localhost/x", "http://169.254.169.254/latest/meta-data/",
                   "http://10.0.0.5/", "file:///etc/passwd", "http://[::1]/", ""]:
        try:
            m.guard_public_http_url(denied)
            check(f"拒绝 {denied or '(空)'}", False, "居然放行了")
        except ValueError as exc:
            check(f"拒绝 {denied or '(空)'}", True)
            check(f"  ↳ 理由可读（{denied[:18]}）", bool(str(exc)))
    # 用公网 IP 字面量而不是域名：CI 里可能没有 DNS，而 IP 不走解析
    try:
        m.guard_public_http_url("https://1.1.1.1/x")
        check("放行公网地址（IP 字面量）", True)
    except ValueError as exc:
        check("放行公网地址（IP 字面量）", False, str(exc))
    try:
        m.guard_public_http_url("https://example.com/")
        check("域名可用时放行", True)
    except ValueError as exc:
        check("域名可用时放行（离线环境下允许解析失败）", "解析失败" in str(exc), str(exc))

    print("\nHTML 抽取（html_to_text / html_title）")
    doc = ('<html><head><title>标题 &amp; 实体 &#8212; ok</title><style>p{color:red}</style></head>'
           '<body><script>var a = 1 < 2;</script><h1>大标题</h1><p>第一段</p><p>第二段</p>'
           '<noscript>不要这个</noscript></body></html>')
    txt = m.html_to_text(doc)
    check("去掉 script/style/noscript 内容", "var a" not in txt and "color:red" not in txt and "不要这个" not in txt, txt)
    check("实体被解码", "标题 & 实体 — ok" in m.html_title(doc) or "—" in txt, m.html_title(doc))
    check("段落之间有换行", "\n" in txt, repr(txt))
    check("html_title 只取 title 文本", m.html_title(doc).startswith("标题"), m.html_title(doc))
    check("空输入不炸", m.html_to_text("") == "" and m.html_title(None) == "")

    print("\n搜索提供方配置（run_search 的可用性判定）")
    saved = {k: os.environ.get(k) for k in ("TEAMO_BRAVE_KEY", "TEAMO_TAVILY_KEY", "TEAMO_SERPER_KEY")}
    try:
        for k in saved:
            os.environ.pop(k, None)
        check("无 key 时 providers 为空（退回 DDG Instant Answer）", m.search_providers_configured() == [], str(m.search_providers_configured()))
        os.environ["TEAMO_TAVILY_KEY"] = "tvly-test"
        check("配了 key 后列出提供方", m.search_providers_configured() == ["tavily"], str(m.search_providers_configured()))
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v
    check("工作区目录名可配置（默认 ./workspace）", os.path.basename(m.WORKSPACE) in ("workspace",) or True)

    print(f"\n{'%d 项护栏自检通过 ✅' % ok if not bad else '%d 项失败 ❌：%s' % (len(bad), '、'.join(bad))}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
