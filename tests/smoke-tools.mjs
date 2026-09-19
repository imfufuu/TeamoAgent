// 冒烟测试用最小工具定义（与 tools.js 中 get_current_time 同构）
export const get_current_time_TOOL = {
  name: 'get_current_time',
  description: '获取当前日期时间。',
  parameters: {
    type: 'object',
    properties: { timezone: { type: 'string', description: 'IANA 时区名，缺省 Asia/Shanghai' } },
  },
};
