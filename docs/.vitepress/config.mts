import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const searchTranslations = {
  button: { buttonText: "搜索文档", buttonAriaLabel: "搜索文档" },
  modal: {
    noResultsText: "没有找到结果",
    resetButtonTitle: "清除查询",
    footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" }
  }
};

export default withMermaid(defineConfig({
  lang: "zh-CN",
  title: "Hearth Eval Agent",
  titleTemplate: ":title · Hearth Eval",
  description: "Hearth 独立评测 Agent：60 个任务、实验编排、评分复核、全周期轨迹与对比。",
  base: "/hearth-eval/",
  cleanUrls: false,
  lastUpdated: true,
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/hearth-eval/logo.svg" }],
    ["meta", { name: "theme-color", content: "#2f7fa8" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "Hearth Eval Agent" }],
    ["meta", { property: "og:description", content: "为个人 Agent 建立可重复、可复核、可对比的评测闭环。" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }]
  ],
  sitemap: { hostname: "https://hearthproject.github.io/hearth-eval/" },
  themeConfig: {
    logo: { src: "/logo.svg", width: 28, height: 28 },
    siteTitle: "Hearth Eval",
    nav: [
      { text: "指南", link: "/guide/getting-started", activeMatch: "^/guide/" },
      { text: "任务集", link: "/guide/task-catalog" },
      { text: "结果", link: "/reference/results" },
      { text: "控制面 API", link: "/reference/api" },
      { text: "场景", link: "/reference/scenarios" }
    ],
    sidebar: {
      "/guide/": [
        {
          text: "开始使用",
          items: [
            { text: "快速开始", link: "/guide/getting-started" },
            { text: "系统架构", link: "/guide/architecture" },
            { text: "评测全周期", link: "/guide/lifecycle" }
          ]
        },
        {
          text: "评测方法",
          items: [
            { text: "任务集", link: "/guide/task-catalog" },
            { text: "评分与复核", link: "/guide/scoring" }
          ]
        }
      ],
      "/reference/": [
        {
          text: "参考",
          items: [
            { text: "Case Manifest", link: "/reference/case-schema" },
            { text: "控制面 API", link: "/reference/api" },
            { text: "白盒场景", link: "/reference/scenarios" },
            { text: "评测结果", link: "/reference/results" },
            { text: "第一阶段验收", link: "/reference/legacy-mvp" }
          ]
        }
      ]
    },
    socialLinks: [{ icon: "github", link: "https://github.com/hearthproject/hearth-eval" }],
    search: {
      provider: "local",
      options: { translations: searchTranslations }
    },
    outline: { level: [2, 3], label: "本页目录" },
    docFooter: { prev: "上一篇", next: "下一篇" },
    lastUpdated: { text: "最后更新", formatOptions: { dateStyle: "medium", timeStyle: "short" } },
    editLink: {
      pattern: "https://github.com/hearthproject/hearth-eval/edit/main/docs/:path",
      text: "在 GitHub 上编辑此页"
    },
    footer: {
      message: "真实任务、真实轨迹、真实复核。",
      copyright: "Apache-2.0 · Hearth Project"
    }
  }
}));
