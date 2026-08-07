import { defineConfig } from "vitepress";

export default defineConfig({
  title: "cf-browser-credentials",
  description:
    "Ephemeral credentials for browser-compute static sites: a Cloudflare Worker broker behind Cloudflare Access, and the client kits that consume it.",
  themeConfig: {
    nav: [
      { text: "The pattern", link: "/" },
      { text: "Packages", link: "/packages/cf-browser-credentials" },
    ],
    sidebar: [
      { text: "The pattern", link: "/" },
      {
        text: "Core",
        items: [
          { text: "cf-browser-credentials", link: "/packages/cf-browser-credentials" },
          { text: "cf-creds-worker", link: "/packages/cf-creds-worker" },
          { text: "cf-loopback-cors", link: "/packages/cf-loopback-cors" },
        ],
      },
      {
        text: "AWS",
        items: [{ text: "cf-creds-aws", link: "/packages/cf-creds-aws" }],
      },
      {
        text: "Providers & integrations",
        items: [
          { text: "cf-creds-openai", link: "/packages/cf-creds-openai" },
          { text: "cf-creds-elevenlabs", link: "/packages/cf-creds-elevenlabs" },
          { text: "cf-creds-mosaic", link: "/packages/cf-creds-mosaic" },
          { text: "cf-creds-zarr", link: "/packages/cf-creds-zarr" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/habemus-papadum/cf_browser_credentials" },
    ],
  },
});
