export default {
  name: "thrower",
  version: "0.1.0",
  commands: [
    {
      name: "plugin-throw",
      description: "抛出未预期错误，用于验证退出码 3",
      handler: () => {
        throw new Error("boom from plugin");
      },
    },
  ],
};
