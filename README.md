# BriefLock

A small app for selling a research brief over Fiber (CKB testnet). The buyer reads a free preview, pays an invoice, and the payment gives them the key to open the full brief and a file. No backend, it all runs in the browser.

I made it for CKBoost Quest 2. It is based on the starter from https://www.fiber.world/docs/build/encrypted-data-payment

Demo video: https://drive.google.com/file/d/1c-SV5SCYLB67IUQ5PB5kH9fiIZV-EJ45/view?usp=sharing

## How it works

The seller writes the brief (title, preview, price, full text, optional file). The browser makes a random AES key and locks the text and file with it. That same key is the preimage of a Fiber invoice, so the invoice only has the hash.

The seller sends the buyer one JSON offer with the preview, price, invoice, ciphertext and a fingerprint of the locked content. The key is never in it. The buyer pastes it, reads the preview, tries "Decrypt without key" (it fails), then pays. Fiber gives back the preimage, which is the key, and the app opens the brief and checks the fingerprint.

## What I changed from the starter

The starter sells one fixed 1 CKB text. Now:

- Free preview and price are in the offer (new `lib/brief.ts`), so the buyer sees them before paying.
- Price can be 1 to 20 CKB. The buyer side refuses to pay if the invoice amount does not match the price in the offer (`lib/payment.ts`).
- Optional file up to 100 KB, encrypted together with the text. Only its name and size are public.
- The offer has a sha256 of the locked content, and the app checks it after unlocking.
- Offer format is v3 now (`lib/offer.ts`).
- New UI in `app/page.tsx` and `app/globals.css`.
- A few tests: `brief.test.mjs`, and one new test in `payment.test.mjs` for the price check.

The node code from the starter (`lib/fiber.ts`, `lib/node-session.ts`, `lib/payment-submission.ts`, `lib/progress.ts`) is the same. It already handles reloads and pending payments so i did not touch it.

## Run it

Node 22.18 or newer.

```sh
npm install
npm run dev
```

Open http://localhost:3001. It has to be `localhost` or https, the wasm runtime needs cross origin isolation (the headers are in `next.config.mjs`).

1. Click **Start node** for Buyer A and Seller C.
2. Copy each address into https://faucet.nervos.org (they are different addresses) and wait for the balance.
3. Click **Open 500 CKB channel** for both and wait for `CHANNEL_READY`. It takes a few minutes. If you get a peer "Init message" error, wait a few seconds and click again.
4. Seller: edit the brief and click **Lock brief**.
5. Copy the offer into the buyer box, **Validate offer**, try **Decrypt without key**, then **Pay**.
6. Click **Unlock**.

Keep one tab per node, and dont clear the browser storage if a node has funds.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

## Notes and limits

- Testnet only. Dont send Mainnet CKB.
- The fingerprint shows the content is what the seller committed to, not that the brief is any good.
- The offer is copy paste, so the file limit is small.
- Max price is 20 CKB because a fresh Bottle channel only has 150 CKB on the seller side.
