export default {
  name: "good",
  version: "0.1.0",
  commands: [
    {
      name: "plugin-echo",
      description: "回显 --text 文本",
      options: [{ flags: "--text <text>", description: "要回显的文本" }],
      handler: (ctx, args) => ({ text: args.text ?? "default" }),
    },
  ],
};
