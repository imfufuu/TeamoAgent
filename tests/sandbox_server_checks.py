#!/usr/bin/env python3
"""Offline local-browser guards; actual Chromium is covered by sandbox-browser.mjs."""
import base64
import http.client
import json
import pathlib
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import server
from sandbox_browser import SandboxBrowser, safe_project_path, project_files, MAX_PROJECT_BYTES, SESSION_IDLE_SECONDS


class ProjectGuards(unittest.TestCase):
    def test_safe_unicode_relative_paths(self):
        self.assertEqual(safe_project_path("网站/assets/按钮.js"), "网站/assets/按钮.js")

    def test_path_traversal_hidden_and_prototype_paths(self):
        for path in ("../x.html", "/x.html", "a/../x.html", "a\\x", ".env", "x/.git/config", "a//b", "internal/key.txt", "node_modules/x.js", "a/__proto__/x", "constructor", "a\x00b"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_project_path(path)

    def test_project_decodes_binary_and_utf8_without_reading_host_files(self):
        files, entry = project_files({"index.html": "网页", "logo.png": "data:image/png;base64," + base64.b64encode(b"png bytes").decode()}, "index.html")
        self.assertEqual(files[entry], "网页".encode())
        self.assertEqual(files["logo.png"], b"png bytes")

    def test_project_entry_is_html_and_must_exist(self):
        for entry in ("missing.html", "index.js", "https://example.com/index.html", "file:///etc/passwd"):
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                project_files({"index.html": "ok"}, entry)

    def test_project_capacity_and_file_count(self):
        with self.assertRaises(ValueError):
            project_files({"index.html": "x" * (MAX_PROJECT_BYTES + 1)}, "index.html")
        with self.assertRaises(ValueError):
            project_files({f"{i}.html": "x" for i in range(513)}, "0.html")

    def test_invalid_binary_payloads(self):
        for value in ("data:text/plain,x", "data:image/png;base64,%%%", None, {}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                project_files({"index.html": "ok", "a.png": value}, "index.html")


class ManagerGuards(unittest.TestCase):
    def setUp(self):
        self.m = SandboxBrowser()
        self.jobs = []
        def rpc(job, on_event=None):
            self.jobs.append(job)
            if on_event:
                on_event({"stream": "stdout", "delta": "loaded\n"})
            return {"ok": True, "preview_id": job["preview_id"]}
        self.m._rpc = rpc

    def tearDown(self):
        self.m.close()

    def start(self):
        return self.m.start({"entry": "index.html", "files": {"index.html": "ok", "app.js": "console.log(1)"}}, 8787)

    def test_start_constructs_internal_loopback_base_and_streams_events(self):
        events = []
        r = self.m.start({"entry": "index.html", "files": {"index.html": "ok"}}, 8787, events.append)
        self.assertRegex(r["preview_id"], r"^[a-f0-9]{32}$")
        self.assertEqual(self.jobs[0]["base"], f'http://127.0.0.1:8787/sandbox-web/{r["preview_id"]}/')
        self.assertEqual(len(events), 1)

    def test_forbidden_url_shell_host_and_port_inputs(self):
        for key in ("url", "host", "port", "base", "command"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.m.start({"entry": "index.html", "files": {"index.html": "ok"}, key: "https://example.com/"}, 8787)
        self.assertEqual(self.jobs, [])

    def test_session_limit_and_stop_release(self):
        ids = [self.start()["preview_id"] for _ in range(3)]
        with self.assertRaises(ValueError):
            self.start()
        self.m.command({"action": "stop", "preview_id": ids[0]})
        self.assertNotIn(ids[0], self.m.sessions)
        self.start()
        self.assertEqual(len(self.m.sessions), 3)

    def test_idle_sessions_expire_before_the_next_start(self):
        r = self.start()
        self.m.sessions[r["preview_id"]]["created"] -= SESSION_IDLE_SECONDS + 1
        self.start()
        self.assertNotIn(r["preview_id"], self.m.sessions)
        self.assertEqual(self.jobs[1]["action"], "stop")

    def test_reload_replaces_only_the_existing_project_entry(self):
        r = self.start()
        self.m.command({"action": "reload", "preview_id": r["preview_id"], "entry": "index.html", "files": {"index.html": "new"}})
        asset = self.m.asset(r["preview_path"])
        self.assertEqual(asset[0], b"new")
        with self.assertRaises(ValueError):
            self.m.command({"action": "reload", "preview_id": r["preview_id"], "entry": "other.html", "files": {"other.html": "wrong"}})

    def test_assets_are_project_scoped_not_host_files(self):
        r = self.start()
        self.assertEqual(self.m.asset(r["preview_path"])[0], b"ok")
        self.assertIsNone(self.m.asset(f'/sandbox-web/{r["preview_id"]}/server.py'))
        self.assertIsNone(self.m.asset('/sandbox-web/' + '0' * 32 + '/index.html'))
        for path in ("../server.py", "%2e%2e%2fserver.py", ".env", "%00x"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.m.asset(f'/sandbox-web/{r["preview_id"]}/{path}')

    def test_unknown_sessions_and_unsupported_actions_rejected(self):
        for payload in ({"action": "screenshot", "preview_id": "0" * 32}, {"action": "navigate", "preview_id": "0" * 32}, {"action": "inspect", "preview_id": "../x"}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.m.command(payload)

    def test_input_limits_are_validated_before_native_rpc(self):
        r = self.start()
        for key, size in (("selector", 2001), ("expression", 8001), ("text", 20001)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.m.command({"action": "evaluate", "preview_id": r["preview_id"], "expression": "1", key: "x" * size})
        self.assertEqual(len(self.jobs), 1)

    def test_failed_and_disconnected_start_do_not_leak_sessions(self):
        self.m._rpc = lambda *_: {"ok": False, "error": "launch failure"}
        self.start()
        self.assertFalse(self.m.sessions)
        jobs = []
        def disconnected(job, *_):
            jobs.append(job)
            return {"ok": True, "_client_disconnected": True} if job["action"] == "start" else {"ok": True}
        self.m._rpc = disconnected
        with self.assertRaises(BrokenPipeError):
            self.start()
        self.assertFalse(self.m.sessions)
        self.assertEqual([j["action"] for j in jobs], ["start", "stop"])

    def test_probe_failures_remain_not_ready_and_cache_only_readiness(self):
        with patch('sandbox_browser.subprocess.run') as run:
            run.return_value.stdout = '{"ok":false,"engine":"chromium","error":"missing system libs"}\n'
            info = self.m.health()
            self.assertFalse(info["ok"])
            self.assertEqual(info["error"], "missing system libs")
            self.m.health()
            self.assertEqual(run.call_count, 1)
        self.assertFalse(self.m.health(enabled=False)["ok"])


class HTTPGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.old_manager = server.SANDBOX_BROWSER
        cls.old_enabled, cls.old_trusted = server.BROWSER_ENABLED, server.BROWSER_REMOTE_TRUSTED
        cls.manager = SandboxBrowser()
        cls.manager._rpc = lambda job, event=None: {"ok": True, "preview_id": job["preview_id"]}
        cls.manager.health = lambda enabled=True: {"ok": bool(enabled), "local": True, "kind": "sandbox-project-browser", "engine": "chromium"}
        server.SANDBOX_BROWSER = cls.manager
        server.BROWSER_ENABLED = True
        server.BROWSER_REMOTE_TRUSTED = False
        cls.httpd = server.Server(('127.0.0.1', 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.manager.close()
        server.SANDBOX_BROWSER = cls.old_manager
        server.BROWSER_ENABLED, server.BROWSER_REMOTE_TRUSTED = cls.old_enabled, cls.old_trusted

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        opts = {'Content-Type': 'application/json'}
        opts.update(headers or {})
        conn.request(method, path, json.dumps(body) if isinstance(body, dict) else body, opts)
        r = conn.getresponse()
        result = r.status, dict(r.getheaders()), r.read().decode()
        conn.close()
        return result

    def test_health_and_json_only_api(self):
        self.assertEqual(self.request('GET', '/api/sandbox-web/health')[0], 200)
        self.assertEqual(self.request('POST', '/api/sandbox-web/health', {})[0], 405)
        self.assertEqual(self.request('GET', '/api/sandbox-web/start')[0], 405)
        self.assertEqual(self.request('POST', '/api/sandbox-web/start', '{}', {'Content-Type': 'text/plain'})[0], 415)

    def test_origin_and_opaque_project_csrf_rejected(self):
        for origin in ('https://evil.example', 'null'):
            with self.subTest(origin=origin):
                self.assertEqual(self.request('POST', '/api/sandbox-web/start', {}, {'Origin': origin})[0], 403)

    def test_cross_site_and_rebinding_hosts_rejected(self):
        self.assertEqual(self.request('GET', '/api/sandbox-web/health', headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        for host in ('evil.example', '[bad'):
            with self.subTest(host=host):
                self.assertEqual(self.request('GET', '/api/sandbox-web/health', headers={'Host': host})[0], 403)

    def test_public_urls_nonfinite_json_and_bad_bodies_rejected(self):
        self.assertEqual(self.request('POST', '/api/sandbox-web/start', {'url': 'https://example.com/'})[0], 400)
        self.assertEqual(self.request('POST', '/api/sandbox-web/start', '{"width": NaN}')[0], 400)
        self.assertEqual(self.request('POST', '/api/sandbox-web/start', '[]')[0], 400)
        self.assertEqual(self.request('POST', '/api/sandbox-web/start', '')[0], 413)

    def test_asset_headers_isolate_scripts_and_allow_opaque_origin_modules(self):
        r = self.manager.start({'entry': 'index.html', 'files': {'index.html': '网页', 'app.js': 'console.log(1)'}}, self.port)
        code, headers, body = self.request('GET', r['preview_path'])
        self.assertEqual(code, 200)
        self.assertEqual(body, '网页')
        self.assertIn('charset=utf-8', headers['Content-Type'])
        self.assertEqual(headers['Access-Control-Allow-Origin'], '*')
        self.assertEqual(headers['X-Frame-Options'], 'SAMEORIGIN')
        csp = headers['Content-Security-Policy']
        self.assertIn('sandbox allow-scripts;', csp)
        self.assertNotIn('allow-same-origin', csp)
        self.assertIn("worker-src 'none'", csp)
        self.assertIn(f'/sandbox-web/{r["preview_id"]}/', csp)
        self.assertEqual(self.request('GET', r['preview_path'].replace('index.html', 'app.js'))[1]['Content-Type'], 'text/javascript; charset=utf-8')
        self.manager.command({'action': 'stop', 'preview_id': r['preview_id']})
        self.assertEqual(self.request('GET', r['preview_path'])[0], 404)

    def test_explicit_disable_does_not_fall_back_to_cloud_or_public_capture(self):
        server.BROWSER_ENABLED = False
        try:
            self.assertFalse(json.loads(self.request('GET', '/api/sandbox-web/health')[2])['ok'])
            self.assertEqual(self.request('POST', '/api/sandbox-web/start', {})[0], 503)
        finally:
            server.BROWSER_ENABLED = True


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if result.wasSuccessful():
        print(f'{result.testsRun} 项护栏自检通过 ✅')
    sys.exit(0 if result.wasSuccessful() else 1)
