// 插件内统一抛错工厂：鸭子类型携带已登记错误码（AGENTS.md §4/§5），壳负责退出码映射
export function cliError(code, message, details) {
  return Object.assign(new Error(message), {
    code,
    ...(details === undefined ? {} : { details }),
  });
}
