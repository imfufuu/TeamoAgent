// ─── UI · /system 隐藏通道命令识别器（P4 拆分：从 mountUI 抽出）─────────────────
// 拥有：handleSystemCommand(input)——本地执行、不走网关的斜杠命令：/help /status /models /use /theme /clear /p2 /p2f /exp /resume …，
//       以及把结果作为一次性草稿消息写入通道（state.js 对 __system__ 不落盘）。
// 不拥有：进入/退出通道（ui-model-picker.js）、消息渲染与滚动——均经 deps 注入；本文件绝不 import ui.js。
import { APP_RELEASE, APP_VERSION } from './config.js?v=2026.10.5.24';
import { getCoarseBrowserEnvironment } from './browser-env.js?v=2026.10.5.24';
import { formatObservabilityReport, formatNexusAcceptanceReport } from './nexus.js';
import { fmtSpan } from './ui-markdown.js?v=2026.10.5.24';

export function installSystemCommands({ store, agent, toast, inSystem, isSystemIsolated, chatModels, selectModel, applyTheme, rebuildMessages, renderSessions, renderFiles, updateStats, scrollToBottom }) {
  // ── /system 隐藏通道：命令识别器（本地执行，不走网关）──
  async function handleSystemCommand(input) {
    const raw = String(input || '').trim();
    store.pushMessage({ role: 'user', text: raw, done: true });
    const cmd = raw.replace(/^[/／]+/, '').trim();
    const sp = cmd.indexOf(' ');
    const name = (sp < 0 ? cmd : cmd.slice(0, sp)).toLowerCase();
    const arg = sp < 0 ? '' : cmd.slice(sp + 1).trim();
    let out = '';
    if (name === 'help' || !name) {
      out = [
        '⌙ /system 可用命令：',
        '/debug on | off —— 开/关调试浮窗（系统日志：网络/错误/审核全链路）',
        '/status —— 版本 / 模型 / 预热 / 审核状态',
        '/version —— 仅版本一行',
        '/env —— 查看粗略浏览器/设备环境（不读取 Cookie 或精确定位）',
        '/stats —— 会话与耗时统计',
        '/model <模型ID> —— 切换模型（需完整 ID）',
        '/models —— 列出可用模型',
        '/theme dark|light —— 切换深/浅主题',
        '/cache [clear] —— 查看离线缓存 / 清空后自动重建',
        '/key —— 查看 API Key 尾号（完整 Key 不回显）',
        '/export —— 导出全部会话记录（JSON 下载）',
        '/clear —— 清空通道草稿（真实会话不受影响）',
        '/p2 [report|policy|fault|exp] —— P2（v2.5）：策略版本 / 统一指标 / 审计三层目标 / 故障注入 / 策略实验',
        '/guard observe|strict|strict-l2 —— 执行内核高风险确认档位（L3 / L2+L3 是否需人工确认）',
        '/resume —— 查看断点续跑计划（未完成步骤 / 需先核验的产物 / 是否需重新确认）',
        '提示：模型菜单搜索 /system 可回到本识别器',
      ].join('\n');
    } else if (name === 'debug') {
      const on = /^(on|1|开|开启|open|show)$/i.test(arg);
      const off = /^(off|0|关|关闭|close|hide)$/i.test(arg);
      if (!on && !off) out = '用法：/debug on 或 /debug off';
      else if (typeof globalThis.__dubheDebugSet !== 'function') out = '调试浮窗模块未加载（旧版本缓存），请强刷页面后重试';
      else {
        const now = globalThis.__dubheDebugSet(on);
        out = now ? '✓ 调试浮窗已开启：审核全链路 / console.warn·error / Agent 状态将实时上屏（Ctrl+Alt+D 可关）'
                  : '✓ 调试浮窗已关闭';
      }
    } else if (name === 'status') {
      const log = globalThis.__dubheModLog || [];
      const pw = [...log].reverse().find((e) => e.stage === 'prewarm:done');
      out = [
        `版本：${APP_RELEASE} · 构建 ${APP_VERSION}`,
        `当前模型：${store.state.model === '__system__' ? '（未选择，处于 /system 通道）' : store.state.model}`,
        `可用模型：${chatModels().length} 个`,
        `调试浮窗：${globalThis.__dubheDebugActive && globalThis.__dubheDebugActive() ? '开启' : '关闭'}`,
        `审核模型预热：${pw ? `已完成（NudeNet ${pw.nudenet ? '✓' : '✗'} / NSFWJS ${pw.nsfwjs ? '✓' : '✗'}${pw.toxicity != null ? ` / Toxicity ${pw.toxicity ? '✓' : '✗'}` : ''}）` : '尚未执行（发图或打开页面 2 秒后自动开始）'}`,
        `内容审核：${store.state.settings.contentModeration === true ? '开启（图片 fail-closed）' : '关闭'}`,
      ].join('\n');
    } else if (name === 'version') {
      out = `Dubhe Agent ${APP_RELEASE} · 构建 ${APP_VERSION}`;
    } else if (name === 'env' || name === 'environment') {
      out = JSON.stringify(getCoarseBrowserEnvironment(), null, 2);
    } else if (name === 'stats') {
      const st = store.state.stats || {};
      const msgs = store.state.messages || [];
      const rounds = msgs.filter((m) => m.role === 'user').length;
      out = [
        `通道草稿：${msgs.length} 条消息（${rounds} 轮）`,
        `真实会话：${(store.state.sessions || []).length} 个（${isSystemIsolated() ? '已隔离，未写入' : '当前'}）`,
        `最近回合：${st.lastMs ? fmtSpan(st.lastMs) : '—'}`,
        `累计耗时：${st.totalMs ? fmtSpan(st.totalMs) : '—'}`,
        '',
        formatObservabilityReport(store.state.lastNexusTelemetry),
        '',
        formatNexusAcceptanceReport({
          memory: store.state.memory || [],
          memoryArchive: store.state.memoryArchive || [],
          telemetry: store.state.lastNexusTelemetry,
          // P0 执行内核（v2.3）：报告里给出当轮真实的状态轨迹、预算账本与静默失败检测结果
          execution: {
            summary: store.state.lastExecutionRecord || null,
            acceptance: store.state.lastExecutionAcceptance || null,
          },
          trajectoryTotals: store.state.trajectoryTotals || null,
          // P2（v2.5）：策略 / 指标 / 审计三层目标 / 故障注入 / 实验 / 执行上下文
          p2Lines: (() => { try { return agent && agent.getP2ReportLines ? agent.getP2ReportLines() : []; } catch { return []; } })(),
        }),
      ].join('\n');
    } else if (name === 'guard') {
      const v = String(arg || '').toLowerCase().trim();
      const modes = { observe: '观察（记录并披露，不打断）', strict: '严格（L3 必须人工确认）', 'strict-l2': '严格+（L2 与 L3 都需确认）' };
      if (!v) out = `当前确认档位：${store.state.settings.executionGuard || 'observe'}（${modes[store.state.settings.executionGuard || 'observe']}）\n用法：/guard observe | strict | strict-l2`;
      else if (!modes[v]) out = '用法：/guard observe | strict | strict-l2';
      else {
        store.state.settings.executionGuard = v;
        store.notify();
        out = `✓ 执行内核确认档位已切换：${v}（${modes[v]}）\n高风险操作会先给出「操作 / 原因 / 影响 / 可逆性 / 参数摘要」，再由你决定是否放行；超时或未应答一律按拒绝处理。`;
      }
    } else if (name === 'p2') {
      // P2 面板：一次看全「策略版本 / 指标 / 审计三层 / 故障 / 实验 / 上下文一致性」
      const sub = String(arg || '').toLowerCase().trim();
      const lines = [];
      if (!sub || sub === 'report') {
        try { lines.push(...(agent && agent.getP2ReportLines ? agent.getP2ReportLines() : ['（执行内核未就绪）'])); } catch (e) { lines.push(`（报告生成失败：${e.message}）`); }
      }
      if (!sub || sub === 'policy') {
        try {
          const r = agent && agent.verifyPolicies ? await agent.verifyPolicies() : null;
          lines.push('', r ? (r.ok ? `✓ 策略注册表自检通过（${r.checked}/${r.total} 项）` : `⚠ 策略漂移：${r.mismatches.map((m) => `${m.key} 声明=${m.declared} 实际=${m.actual}`).join('；')}`) : '（策略自检不可用）');
        } catch (e) { lines.push(`（策略自检失败：${e.message}）`); }
      }
      if (!sub || sub === 'fault') {
        const kinds = ['tool-timeout', 'tool-empty-result', 'tool-bad-schema', 'artifact-modified-externally', 'duplicate-tool-call', 'audit-event-missing', 'capability-mask-mismatch', 'memory-instruction-conflict', 'authorization-revoked-midway'];
        const want = String(arg || '').split(/\s+/).slice(1);
        if (want.length && agent && agent.armFaultInjection) {
          const r = agent.armFaultInjection(want);
          lines.push('', r.cleared ? '✓ 已清除待注入故障' : `✓ 已装备故障注入：${r.kinds.join('、')}（下一轮生效一次）`);
        } else {
          lines.push('', '可用故障类型（下一轮生效一次）：', kinds.map((k) => `  · ${k}`).join('\n'), '用法：/p2 fault tool-timeout 或 /p2 fault tool-timeout,audit-event-missing');
        }
      }
      if (!sub || sub === 'exp') {
        const id = 'guard-default';
        try {
          const rep = agent && agent.getExperimentReport ? agent.getExperimentReport(id) : null;
          lines.push('', rep && rep.ok ? `实验 ${id}：${rep.action}（${rep.reason}）｜对照 n=${rep.control.samples} 变体 n=${rep.treatment.samples}` : `实验 ${id}：尚无足够样本（灰度默认关闭，需在设置里显式开启 allocation）`);
        } catch (e) { lines.push(`（实验汇总失败：${e.message}）`); }
      }
      out = lines.join('\n');
    } else if (name === 'resume') {
      let plan = null;
      try { plan = agent && agent.getResumePlan ? agent.getResumePlan() : null; } catch { plan = null; }
      if (!plan) out = '当前没有可续跑的执行检查点（完成一轮工具任务后才会生成）。';
      else {
        out = [
          `断点续跑计划（检查点 ${plan.checkpointId || '-'}，策略 ${plan.policyVersion || '-'}）`,
          plan.summary,
          plan.reusableSteps && plan.reusableSteps.length ? `可直接复用：${plan.reusableSteps.join('、')}` : '可直接复用：无',
          plan.verificationSteps && plan.verificationSteps.length ? `续跑前先核验：${plan.verificationSteps.join('；')}` : '续跑前先核验：无（产物与检查点一致）',
          plan.needsConfirmation ? '⚠ 涉及高风险或能力变化：续跑前需要你明确确认' : '无需重新确认',
        ].join('\n');
      }
    } else if (name === 'theme') {
      const v = String(arg || '').toLowerCase();
      if (v !== 'dark' && v !== 'light') out = '用法：/theme dark 或 /theme light';
      else { store.state.settings.theme = v; applyTheme(); store.notify(); out = `✓ 主题已切换：${v === 'dark' ? '深色' : '浅色'}`; }
    } else if (name === 'cache') {
      if (typeof caches === 'undefined') out = '当前环境不支持 Cache Storage（需 https 或 localhost）';
      else {
        const names = await caches.keys();
        if (/^(clear|清空|clean)$/i.test(arg)) {
          await Promise.all(names.map((n) => caches.delete(n)));
          out = `✓ 已清空 ${names.length} 个离线缓存。刷新页面后自动重建（模型/审核资产会重新下载一次）`;
        } else {
          let n = 0;
          for (const nm of names) { try { n += (await (await caches.open(nm)).keys()).length; } catch { /* 忽略 */ } }
          out = `离线缓存：${names.length} 个（${names.join('、') || '无'}），共 ${n} 条资产\n用法：/cache clear 清空（SW 之后自动重建）`;
        }
      }
    } else if (name === 'key') {
      const k = store.state.apiKey || '';
      out = k ? `API Key：${k.slice(0, 10)}…${k.slice(-4)}（已配置；完整 Key 不回显）` : '尚未配置 API Key（普通对话需要；/system 通道本身不需要）';
    } else if (name === 'export') {
      try {
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), version: APP_VERSION, sessions: store.state.sessions }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dubhe-sessions-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        out = `✓ 已导出 ${(store.state.sessions || []).length} 个会话（JSON，含沙箱文件清单）`;
      } catch (e) { out = `导出失败：${e && e.message ? e.message : e}`; }
    } else if (name === 'model') {
      const id = arg.trim();
      if (!id) out = '用法：/model <模型完整 ID>（如 /model claude-sonnet-5）';
      else if (id === '__system__') out = '不能切换到保留标识';
      else if (chatModels().some((m) => m.id === id)) { selectModel(id); out = `✓ 已切换模型：${id}`; }
      else out = `未找到模型「${id}」——输入 /models 查看可用列表`;
    } else if (name === 'models') {
      const ids = chatModels().map((m) => m.id);
      out = `可用模型 ${ids.length} 个：\n` + ids.join('、');
    } else if (name === 'clear') {
      store.state.messages = [];
      store.state.checkpoints = [];
      // 通道内清的是一次性草稿；真实沙箱文件只在真实会话里才动
      if (!inSystem()) { try { agent.loadFiles({}); } catch { /* 忽略 */ } }
      store.notify();
      rebuildMessages(); renderFiles(); updateStats();
      out = inSystem() ? '✓ 通道草稿已清空（真实会话不受影响）' : '✓ 当前会话消息与沙箱文件已清空（会话本身保留）';
    } else {
      out = `未知命令「${name}」——输入 /help 查看可用命令`;
    }
    store.pushMessage({ role: 'assistant', text: out, model: '__system__', done: true });
    store.notify();
    rebuildMessages(); renderSessions(); updateStats();
    const last = store.state.messages[store.state.messages.length - 1];
    if (last && last.model === '__system__') { try { scrollToBottom(); } catch { /* 忽略 */ } }
  }
  return { handleSystemCommand };
}
