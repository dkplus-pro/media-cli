// 插件内统一抛错工厂：鸭子类型携带已登记错误码（D7），壳负责识别与退出码映射
export function cliError(code, message, details) {
  return Object.assign(new Error(message), {
    code,
    ...(details === undefined ? {} : { details }),
  });
}
