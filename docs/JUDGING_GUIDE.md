# Run and evaluate HoldOn

HoldOn is a local, single-operator PayPal Sandbox prototype. Buyer and Seller are demo views, not separate authenticated users. Run one Node process for the project.

## Requirements

- Node.js 24 and npm.
- A PayPal Sandbox Business app and a separate Sandbox Personal test buyer.
- DeepSeek API access to `deepseek-flash` for image input and JSON output.
- Network access to the PayPal and DeepSeek APIs.

No live payment credentials or real bank card are needed. The backend rejects a production PayPal API base. PayPal transactions in this app are simulated Sandbox transactions. DeepSeek API requests use the configured account's quota and are not represented as free.

## Install

1. Extract the source package or clone the approved public repository.
2. Copy `.env.example` to `.env.local`.
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `DEEPSEEK_API_KEY` using the credentials arranged for judging. Keep `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`, `LLM_PROVIDER=deepseek`, and `LLM_MODEL=deepseek-flash`.
4. Run:

```sh
npm ci
npm test
npm run build
npm run start
```

5. Open `http://127.0.0.1:3000` in your browser.

Alternatively, use `npm run dev` for development. For a different port, run `npm run start -- --port 3001`. Payment callbacks are generated from the browser's local origin.

## Verify the main workflow

1. Select **Start a deal**, choose **Logo scope and revisions**, and run the real AI analysis. The sample is fictional.
2. Review the priced checklist and non-priced scope terms. Confirm the same saved version in Buyer and Seller views. Editing either clears both confirmations.
3. Paste this new request into **Is this extra work?**:

   “Please add packaging artwork and a five-second animated logo. Also fix the company name from Mapel Bakery to Maple Bakery in the original logos.”

4. Inspect the categories and quoted terms. The model's wording can vary. If a term was extracted incorrectly, correct and reconfirm it rather than assuming the AI is authoritative.
5. In Seller view, select the extra work only. Set a $45 quote with a 48-hour delivery window and clearly describe the packaging and animation. Save and confirm as Seller, then confirm as Buyer.
6. Open the new order. It should show $45 and link to the unchanged $120 original. Use **Open PayPal approval link** to authorize it. This path was verified; the full SDK popup callback remains unverified.
7. Sign in to the **Sandbox** checkout using the **Sandbox Personal buyer**, not the real Developer account. Sandbox buyer logins can have generated `@personal.example.com` addresses. Find their test passwords in the real Developer Dashboard's Sandbox account details. Never try those generated accounts on the production PayPal login page.
8. After returning to HoldOn, switch to Seller view. Submit `packaging-demo.png`, `packaging-demo.pdf`, `animation-inspection.png`, and `animation-demo.zip` from `samples/delivery/scope-verification/`, with a note identifying them as test evidence. The inspection PNG is one animation frame; it does not establish the ZIP contents or animation duration. The previously recorded payment check used the three files without this inspection frame.
9. Inspect the review. The model can inspect the PNG, while the PDF and ZIP require human review. Download and inspect those files before accepting. Record a reason for acceptance beyond AI-supported evidence.
10. Save full acceptance, then confirm the $45 capture as Buyer. Full-price acceptance uses the seller's already-recorded agreement. Check the resulting captured amount and timeline. A repeated release must not create a second capture.

## Other checks

- A reduced settlement, including a $0 closure, requires seller agreement.
- Editing an unaccepted change quote clears its confirmations; an accepted quote produces one locked child order.
- The dashboard uses AG Grid Community for sorting, filtering and reviewing actual stored deals.
- `npm test` uses simulated API responses and temporary data, so it does not require API keys or make a real Sandbox capture.
- `docs/verification-summary.json` describes the recorded live check. It is evidence, not seeded application state or a substitute for an interactive run.

## Reviewer access status

Dedicated DeepSeek access, PayPal Sandbox app credentials and a separate Personal test buyer are supplied in the Devpost submission's judges/organizers-only testing instructions. Use those details with the setup above; the author provides the configured API access for evaluation. The source package intentionally contains no passwords, API keys or private transaction database. Keep the supplied credentials private. If access fails, contact the entrant through Devpost rather than purchasing API credit for this demonstration.

## Data and limits

Chat text, notes and eligible images are sent to DeepSeek when analysis is requested. Data and uploads persist in the local `data/` directory. This prototype has no public authentication or multi-seller onboarding. It supports one capture per order. Long delivery periods require attention to PayPal authorization validity; reauthorization is not implemented. No fraud-prevention, automatic dispute-resolution or guaranteed payment-protection claim is made.
