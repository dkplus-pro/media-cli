export default {
  name: "hello",
  version: "0.1.0",
  commands: [
    {
      name: "hello",
      description: "问候示例命令（业务功能最小模板）",
      options: [{ flags: "--name <name>", description: "要问候的对象（默认 world）" }],
      handler: (_ctx, args) => ({ message: `hello, ${args.name ?? "world"}!` }),
    },
  ],
};
