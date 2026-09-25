import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { formatMoney } from "../../lib/catalog";
import type { Currency } from "../../lib/types";

test("webhook checkout receives an external callback, clears the cart, and can be found by MD5", async ({ page, request }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("storefront-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Add Mondulkiri coffee to bag", exact: true }).click();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Signed", exact: true }).click();
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const { data: transaction } = await (await checkoutResponse).json();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /KHQR payment/ })).toBeVisible();
  await expect(dialog.getByText("Listening for webhook events")).toBeVisible();
  await expect(dialog.getByText("Signed webhook", { exact: true })).toBeVisible();
  expect(transaction.webhookSignatureMode).toBe("signed");
  const body = JSON.stringify({ md5: transaction.md5, status: "paid", amount: 8.5, currency: "USD", toAccountId: transaction.accountId, transactionId: "browser-external-callback" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", "browser-test-secret").update(`${timestamp}.${body}`).digest("hex");
  const unsignedAttempt = await request.post("/api/v1/transactions/callback", { headers: { "Content-Type": "application/json" }, data: body });
  expect(unsignedAttempt.status()).toBe(401);
  await expect(dialog.getByRole("heading", { name: "Scan. Pay. All yours." })).toBeVisible();
  const callback = await request.post("/api/v1/transactions/callback", {
    headers: { "Content-Type": "application/json", "x-webhook-timestamp": timestamp, "x-webhook-signature": `sha256=${signature}` },
    data: body,
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

test("token webhook requires x-webhook-secret and does not need an Open API token", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Token", exact: true }).click();
  await page.getByRole("button", { name: "Add The everyday cup to bag", exact: true }).click();
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const { data: transaction } = await (await checkoutResponse).json();
  expect(transaction.webhookSignatureMode).toBe("token");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Token webhook", { exact: true })).toBeVisible();
  const payload = { md5: transaction.md5, status: "paid", amount: transaction.amount, currency: transaction.currency, toAccountId: transaction.accountId, transactionId: "browser-token-payment" };
  expect((await request.post("/api/v1/transactions/callback", { data: payload })).status()).toBe(401);
  const callback = await request.post("/api/v1/transactions/callback", { headers: { "x-webhook-secret": "browser-test-secret" }, data: payload });
  expect(callback.ok()).toBeTruthy();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
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

test("provider batch callback updates checkout and returns the exact acknowledgement", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Unsigned", exact: true }).click();
  await page.getByRole("button", { name: "Add Room for ideas to bag", exact: true }).click();
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const { data: transaction } = await (await checkoutResponse).json();
  const response = await request.post("/api/v1/transactions/callback", { data: {
    requestId: "0001",
    transactions: [{
      fromAccountId: "sender_acc@cmcb",
      toAccountId: transaction.accountId,
      assetId: `${transaction.currency.toLowerCase()}#nbc`,
      amount: transaction.amount,
      description: "Pay back",
      createdDateMilli: 1676962944719,
      hash: "805712c84f0e678d54adfa999835f0c415394732957bdd645e545d0d9969f802",
      qrCode: transaction.qr,
      qrType: "CORPORATE",
      senderName: "Channit Rom",
      senderAccount: "321456654",
      senderBank: "CMCBKHPPXX",
      status: "SUCCESS",
    }],
  } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: { code: 0, errorCode: null, error: null, message: null, warning: null } });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
  await expect(dialog.getByText("Payment confirmed by webhook callback.")).toBeVisible();
});

test("unsigned webhook selection persists and accepts an external plain JSON callback", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Unsigned", exact: true }).click();
  await page.reload();
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unsigned", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Add Market day tote to bag", exact: true }).click();
  const checkoutResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/transactions") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const { data: transaction } = await (await checkoutResponse).json();
  expect(transaction.webhookSignatureMode).toBe("unsigned");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Unsigned webhook", { exact: true })).toBeVisible();
  const response = await request.post("/api/v1/transactions/callback", {
    data: { md5: transaction.md5, status: "paid", amount: transaction.amount, currency: transaction.currency, toAccountId: transaction.accountId, transactionId: "browser-unsigned-payment" },
  });
  expect(response.ok()).toBeTruthy();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to the store", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("unsigned webhook simulator completes checkout", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("All systems ready")).toBeVisible();
  await page.getByRole("button", { name: "Webhook", exact: true }).click();
  await page.getByRole("button", { name: "Unsigned", exact: true }).click();
  await page.getByRole("button", { name: "Add The everyday cup to bag", exact: true }).click();
  await page.getByRole("button", { name: "Checkout with KHQR" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Unsigned webhook", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Simulate successful payment", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "A little good, on its way." })).toBeVisible();
});
