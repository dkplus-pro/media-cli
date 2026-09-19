export default {
  name: "good",
  version: "0.2.0",
  commands: [
    {
      name: "plugin-echo-dup",
      description: "用于验证同名插件去重",
      handler: () => ({ from: "dup" }),
    },
  ],
};
