import { expect, test } from "@playwright/test";
import { formatMoney } from "../../lib/catalog";
import type { Currency } from "../../lib/types";

test("webhook checkout receives an external callback, clears the cart, and can be found by MD5", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("storefront-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Add Mondulkiri coffee to bag", exact: true }).click();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const { data: transaction } = await (await checkoutResponse).json();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /KHQR payment/ })).toBeVisible();
  await expect(dialog.getByText("Listening for webhook events")).toBeVisible();
  const callback = await request.post("/api/v1/transactions/callback", {
    headers: { "x-webhook-secret": "browser-test-secret" },
    data: { md5: transaction.md5, status: "paid", amount: 8.5, currency: "USD", toAccountId: transaction.accountId, transactionId: "browser-external-callback" },
  });
  expect(callback.ok()).toBeTruthy();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
  await expect(dialog.getByText("Payment confirmed by webhook callback.")).toBeVisible();
  await dialog.getByRole("button", { name: "Back to the store" }).click();
  await expect(page.getByText("A little room for good things.")).toBeVisible();
  await page.getByRole("button", { name: "Transactions", exact: true }).click();
  await page.getByRole("textbox", { name: "Transaction MD5" }).fill(transaction.md5);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
});

test("polling discovers a simulated provider payment", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add The everyday cup to bag", exact: true }).click();
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Polling", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Simulate successful payment", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible({ timeout: 12_000 });
  await expect(dialog.getByText("Payment confirmed by MD5 polling.")).toBeVisible();
});

test("failed webhook simulation leaves the cart available for retry", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Add Market day tote to bag", exact: true }).click();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Simulate a failed payment", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Let’s try that again." })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to checkout", exact: true }).click();
  await expect(page.getByRole("button", { name: "Checkout with KHQR" })).toBeEnabled();
});

test("mobile KHR checkout, product filters, and API guide work without horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.screenshot({ path: testInfo.outputPath("storefront-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(2);
  await page.getByRole("combobox", { name: "Currency", exact: true }).selectOption("KHR");
  await page.getByRole("button", { name: "Add The everyday cup to bag", exact: true }).click();
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /KHQR payment for.*48,000/ })).toBeVisible();
  await dialog.getByRole("button", { name: "Simulate successful payment", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible({ timeout: 12_000 });
  await dialog.getByRole("button", { name: "Back to the store", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: "API guide", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your API endpoints" })).toBeVisible();
  await expect(page.locator(".endpoint-row").filter({ hasText: "/api/v1/transactions/callback" })).toBeVisible();
});

for (const scenario of [
  { currency: "USD" as Currency, product: "Room for ideas", price: 0.29, mobile: false },
  { currency: "KHR" as Currency, product: "A quieter moment", price: 137, mobile: true },
]) {
  test(`editing a ${scenario.currency} price updates the cart, KHQR, and saved catalog`, async ({ page }) => {
    if (scenario.mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: `Add ${scenario.product} to bag`, exact: true }).click();
    await page.getByRole("button", { name: `Add one ${scenario.product}`, exact: true }).click();
    await page.getByRole("button", { name: `Edit price for ${scenario.product}`, exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit product price" });
    await editor.getByRole("combobox", { name: "Currency", exact: true }).selectOption(scenario.currency);
    await editor.getByRole("spinbutton", { name: "Price", exact: true }).fill(String(scenario.price));
    await editor.getByRole("button", { name: "Save price", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.getByRole("combobox", { name: "Currency", exact: true })).toHaveValue(scenario.currency);
    await expect(page.locator(".total-row")).toContainText(formatMoney(scenario.price * 2, scenario.currency));
    const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Checkout with KHQR" }).click();
    const { data: transaction } = await (await checkoutResponse).json();
    expect(transaction.currency).toBe(scenario.currency);
    expect(transaction.amount).toBe(scenario.price * 2);
    expect(transaction.items[0].unitPrice).toBe(scenario.price);
    const checkout = page.getByRole("dialog");
    await expect(checkout.getByRole("img", { name: `KHQR payment for ${formatMoney(scenario.price * 2, scenario.currency)}` })).toBeVisible();
    await checkout.getByRole("button", { name: "Close checkout", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: `Edit price for ${scenario.product}`, exact: true }).click();
    await expect(editor.getByRole("combobox", { name: "Currency", exact: true })).toHaveValue(scenario.currency);
    await expect(editor.getByRole("spinbutton", { name: "Price", exact: true })).toHaveValue(String(scenario.price));
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
}

test("price edit errors preserve the draft and cancel leaves the saved price intact", async ({ page }) => {
  await page.goto("/");
  const product = page.locator(".product-card").filter({ has: page.getByRole("heading", { name: "The go-everywhere", exact: true }) });
  await product.getByRole("button", { name: "Edit price for The go-everywhere" }).click();
  const editor = page.getByRole("dialog", { name: "Edit product price" });
  await editor.getByRole("spinbutton", { name: "Price", exact: true }).fill("2.99");
  await page.route("**/api/v1/products/daily-bottle", (route) => route.fulfill({ status: 503, json: { error: "Price changes temporarily unavailable." } }));
  await editor.getByRole("button", { name: "Save price", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("Price changes temporarily unavailable.");
  await expect(editor.getByRole("spinbutton", { name: "Price", exact: true })).toHaveValue("2.99");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(product.locator(".product-bottom > strong")).toHaveText("$18.00");
});
