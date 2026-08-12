import { expect, test } from "@playwright/test";

test("demo app renders hello world landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /hello from the demo app/i })).toBeVisible();
  await expect(page.getByText("Turborepo + pnpm template")).toBeVisible();
});
