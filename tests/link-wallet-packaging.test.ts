import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("Link Agent Wallet packaging", () => {
  it("pins the official CLI without adding deployment credentials", async () => {
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .parse(
        JSON.parse(
          await readFile(new URL("../package.json", import.meta.url), "utf8")
        )
      );
    const workspace = await readFile(
      new URL("../pnpm-workspace.yaml", import.meta.url),
      "utf8"
    );
    const environment = await readFile(
      new URL("../.env.example", import.meta.url),
      "utf8"
    );

    expect(manifest.dependencies["@stripe/link-cli"]).toBe("0.14.0");
    expect(workspace).toMatch(/["']@stripe\/link-cli["']:\s*false/u);
    expect(environment).not.toContain("STRIPE_SECRET_KEY");
    expect(environment).not.toContain("LINK_ACCESS_TOKEN");
    expect(environment).not.toMatch(/^(?:STRIPE|LINK)_[A-Z_]*=/mu);
  });

  it("keeps the CLI in Next and Eve hosted output", async () => {
    const nextConfig = await readFile(
      new URL("../next.config.ts", import.meta.url),
      "utf8"
    );
    const workerConfig = await readFile(
      new URL("../agent/subagents/worker/agent.ts", import.meta.url),
      "utf8"
    );

    expect(nextConfig).toContain(
      'serverExternalPackages: ["@stripe/link-cli"]'
    );
    expect(nextConfig).toContain("outputFileTracingIncludes");
    expect(workerConfig).toContain(
      'externalDependencies: ["@stripe/link-cli"]'
    );
  });

  it("documents Link approval as the single purchase confirmation", async () => {
    const instructions = await readFile(
      new URL("../agent/instructions.md", import.meta.url),
      "utf8"
    );
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );

    expect(instructions).toContain(
      "A completed Link Agent Wallet spend approval is the single purchase approval"
    );
    expect(instructions).toContain("immediately continue that same worker");
    expect(readme).toContain("No Stripe API key");
    expect(readme).toContain("currently available to US Link accounts");
    expect(readme).toContain(
      "repository-url=https%3A%2F%2Fgithub.com%2Fgratitude5dee%2FOpenInstinct"
    );
    expect(readme).toContain("https://vercel.com/button");
    expect(readme).toContain(
      "git clone https://github.com/gratitude5dee/OpenInstinct.git"
    );
  });

  it("preserves the complete one-click Vercel template contract", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    const deployButton =
      /\[!\[Deploy with Vercel\]\(https:\/\/vercel\.com\/button\)\]\((https:\/\/vercel\.com\/new\/clone\?[^)]+)\)/u.exec(
        readme
      )?.[1];

    expect(deployButton).toBeDefined();
    const url = new URL(deployButton ?? "https://invalid.example");
    expect(url.origin + url.pathname).toBe("https://vercel.com/new/clone");
    expect(url.searchParams.get("repository-url")).toBe(
      "https://github.com/gratitude5dee/OpenInstinct"
    );
    expect(url.searchParams.get("project-name")).toBe("open-instinct");
    expect(url.searchParams.get("repository-name")).toBe("open-instinct");

    const products = z
      .array(
        z.object({
          integrationSlug: z.string(),
          productSlug: z.string(),
          protocol: z.string(),
          type: z.string(),
        })
      )
      .parse(JSON.parse(url.searchParams.get("products") ?? "[]"));
    expect(products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          integrationSlug: "kernel",
          productSlug: "kernel",
        }),
        expect.objectContaining({
          integrationSlug: "neon",
          productSlug: "neon",
        }),
      ])
    );

    const stores = z
      .array(z.object({ access: z.string(), type: z.string() }))
      .parse(JSON.parse(url.searchParams.get("stores") ?? "[]"));
    expect(stores).toContainEqual({ access: "private", type: "blob" });

    const configuration = [...url.searchParams].flat().join("\n");
    expect(configuration).not.toMatch(/(?:STRIPE|LINK)_[A-Z_]+/u);
  });
});
