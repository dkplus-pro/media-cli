import { compress, faceCover, gridCaption, toPdf, watermark } from "./lib/commands.mjs";

// 纯 manifest：handler 全在 lib/commands.mjs（AGENTS.md §6 的 300 行红线；suno-music/agnes 同款房子风格）
export default {
  name: "media-image",
  version: "0.1.0",
  commands: [
    {
      name: "media-compress",
      description: "压缩图片体积（不改变分辨率、不转格式），支持文件与文件夹批量",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.min.<ext>，文件夹默认 ./min）",
        },
        {
          flags: "--quality <1-100>",
          description: "有损格式质量（默认 80；PNG 为无损优化不受影响）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: compress,
    },
    {
      name: "media-watermark",
      description:
        "图片平铺斜角文字水印（默认 30°），支持字体/文案/间距/透明度/字号/颜色，支持文件与文件夹批量",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        { flags: "--text <text>", description: "水印文案（必填）" },
        {
          flags: "--font <family>",
          description: "字体族（默认 sans-serif，由系统 fontconfig 解析）",
        },
        { flags: "--angle <deg>", description: "旋转角度，-360~360（默认 30）" },
        { flags: "--spacing <px>", description: "相邻水印间距像素（默认 80）" },
        { flags: "--opacity <0-1>", description: "透明度 (0, 1]（默认 0.3）" },
        { flags: "--font-size <px>", description: "字号像素（默认按图片最短边自适应）" },
        { flags: "--color <color>", description: "文字颜色（默认 #ffffff）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.watermark.<ext>，文件夹默认 ./watermark）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: watermark,
    },
    {
      name: "media-face-cover",
      description:
        "人脸遮罩：Apple Vision 本地检脸（离线，需 macOS + swiftc）后在每张脸上叠实心白圆，漏检可用 --at 人工补",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        {
          flags: "--output <path>",
          description: "输出文件/目录（单文件默认 <name>.covered.<ext>，文件夹默认 ./face-cover）",
        },
        {
          flags: "--scale <0.5-3>",
          description: "人脸框内切圆的放大倍数（默认 1.2，多盖住发际线与下巴）",
        },
        {
          flags: "--at <x,y,r...>",
          description: "人工遮脸圆（像素、左上原点），可重复传多个，与检测结果合并；侧脸/漏检兜底",
        },
        {
          flags: "--min-confidence <0-1>",
          description: "低于此置信度的脸不遮（默认 0.3）",
        },
        { flags: "--color <color>", description: "圆填充色（默认 #FFFFFF）" },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: faceCover,
    },
    {
      name: "media-to-pdf",
      description: "多张图片合并为一个 PDF（单文件出一页，文件夹内全部图片按文件名自然序合成多页）",
      options: [
        { flags: "--input <path>", description: "图片文件或文件夹（jpg/jpeg/png/webp）" },
        {
          flags: "--output <path>",
          description: "输出 .pdf 路径（单文件默认 <name>.pdf，文件夹默认 <目录名>.pdf）",
        },
        {
          flags: "--order <order>",
          description:
            "页面顺序：natural 文件名自然序，page2 在 page10 前（默认）| lexicographic 纯字典序",
        },
        {
          flags: "--page <size>",
          description: "页面尺寸：image 每页贴合图片（默认）| a4 | letter",
        },
        {
          flags: "--orientation <mode>",
          description: "固定页面时的页向：auto 随图片横竖自动（默认）| portrait | landscape",
        },
        {
          flags: "--margin <pt>",
          description: "固定页面四周留白磅值（默认 0，仅 --page a4|letter 生效）",
        },
        {
          flags: "--dpi <72-1200>",
          description: "像素到磅的换算密度（默认 300；--page image 决定页面物理尺寸）",
        },
        {
          flags: "--image-format <fmt>",
          description: "页内图片编码：jpeg（默认，透明压白底）| png（无损、保留透明）",
        },
        {
          flags: "--quality <1-100>",
          description: "jpeg 编码质量（默认 85；--image-format png 无效）",
        },
        {
          flags: "--skip-broken",
          description: "容忍无法解码的图片（默认任一张失败即整体报错且不落盘）",
        },
        { flags: "--recursive", description: "文件夹输入时递归子目录（默认仅一级）" },
      ],
      handler: toPdf,
    },
    {
      name: "media-grid-caption",
      description:
        "宫格加字幕：给九宫格/分镜页的每一格底部叠半透明黑条+白字（自动字号自动换行，不改整图尺寸）；定位失败时外扩到底部",
      options: [
        {
          flags: "--input <path>",
          description: "单张宫格图（jpg/jpeg/png/webp；本命令不支持目录批量）",
        },
        {
          flags: "--cells <path>",
          description:
            "cells JSON（doubao-grid-locate --output 的产物，或手写）：含每格 x/y/w/h 与可选 text，坐标为像素、左上原点",
        },
        {
          flags: "--captions <path>",
          description:
            '字幕 JSON 数组 [{"index":0,"text":"...","fontSize":42,"align":"center"}]，按 index 与格子合并',
        },
        { flags: "--cols <n>", description: "人工等分列数（须与 --rows 同时给，给了就跳过检测）" },
        { flags: "--rows <n>", description: "人工等分行数（须与 --cols 同时给）" },
        {
          flags: "--locate",
          description: "允许本地自动检测宫格（默认开启；只认分隔线对齐的规则宫格）",
        },
        {
          flags: "--no-locate",
          description: "关闭本地自动检测（检测不到的倾斜/错位分镜页建议关掉，直接用 --cells）",
        },
        {
          flags: "--font <family>",
          description: "字体族名（默认 sans-serif，实测可渲染中文；不是字体文件路径）",
        },
        { flags: "--font-size <px>", description: "字号 6-1000（默认每格按格宽自适应）" },
        { flags: "--text-color <color>", description: "字幕颜色（默认 #FFFFFF）" },
        {
          flags: "--opacity <0-1>",
          description: "黑条不透明度（默认 0.75 半透明；传 1 即纯黑）",
        },
        { flags: "--padding <px>", description: "黑条内边距像素（默认 12）" },
        {
          flags: "--position <bottom|top>",
          description: "黑条在格内的位置：bottom（默认）| top",
        },
        {
          flags: "--flat-tol <0-255>",
          description: "本地检测：像素与背景色的灰度容差（默认 24；越大越容易把内容误判成分隔带）",
        },
        {
          flags: "--min-gutter <n>",
          description: "本地检测：分隔带最小厚度像素（默认 3）",
        },
        {
          flags: "--max-overlap <fraction>",
          description:
            "格子重叠的分级阈值：重叠面积占**较小格面积**的比重 ≤ 此值只发 E_CELLS_OVERLAP 警告并照常渲染，" +
            "超过才报 E_INVALID_OPTION（默认 0.05，与 doubao-grid-locate 的修复窗口同值，保证产出侧发得出来的文件消费侧默认必收）。" +
            "视觉模型坐标放大回原图的残留薄条实测 3.5%–4.6%，真误检是 11%–33%；范围 0-1，0 = 一点重叠都按硬错拒收",
        },
        {
          flags: "--allow-overlap",
          description:
            "完全放行 --cells 里的格子重叠（连 E_CELLS_OVERLAP 警告也不发）。默认按 --max-overlap 分级：小重叠警告、大重叠拒绝——重叠会让同一格画上两条字幕，刻意的分层版式才需要全放行",
        },
        {
          flags: "--output <path>",
          description: "输出图片路径（默认 <name>.captioned.<ext>；传目录则落在目录里）",
        },
      ],
      handler: gridCaption,
    },
  ],
};
