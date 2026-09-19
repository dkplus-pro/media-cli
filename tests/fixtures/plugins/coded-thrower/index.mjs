export default {
  name: "coded-thrower",
  version: "0.1.0",
  commands: [
    {
      name: "coded-throw",
      description: "抛出带已登记错误码的错误，验证鸭子类型抛错通道",
      handler: () => {
        throw Object.assign(new Error("bad config"), {
          code: "E_CONFIG",
          details: { var: "SUNO_API_KEY" },
        });
      },
    },
  ],
};
