import { appTools, defineConfig } from "@modern-js/app-tools";

const devServerPort = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : undefined;

const githubPagesBasePath = normalizeGitHubPagesBasePath(
  process.env.GITHUB_PAGES_BASE_PATH ?? inferGitHubPagesBasePath()
);

function inferGitHubPagesBasePath() {
  if (process.env.GITHUB_ACTIONS !== "true" || !process.env.GITHUB_REPOSITORY) {
    return undefined;
  }

  const repositoryName = process.env.GITHUB_REPOSITORY.split("/").pop();
  return repositoryName ? `/${repositoryName}/` : undefined;
}

function normalizeGitHubPagesBasePath(basePath?: string) {
  const trimmedBasePath = basePath?.trim();
  if (!trimmedBasePath || trimmedBasePath === "/") {
    return undefined;
  }

  return `/${trimmedBasePath.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig({
  html: {
    outputStructure: "flat",
    title: "Monorepo Template Demo"
  },
  output: {
    distPath: {
      html: ""
    },
    ...(githubPagesBasePath ? { assetPrefix: githubPagesBasePath } : {})
  },
  ...(devServerPort ? { server: { port: devServerPort } } : {}),
  plugins: [appTools()]
});
