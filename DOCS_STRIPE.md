# MCPfinder Stripe Integration Plan (MVP)

## Goal

To enable monetization for MCP publishers, allowing them to charge users for installing their MCP servers via MCPfinder. MCPfinder will facilitate the payment process using Stripe Connect and collect a commission on each transaction.

## Chosen Platform: Stripe Connect

We will use Stripe Connect, specifically the **Destination Charges** or **Separate Charges and Transfers** model with an **Application Fee**. This allows MCPfinder (the platform) to:

1.  Create charges for users based on the price defined in the MCP manifest.
2.  Automatically deduct a platform commission (application fee).
3.  Route the remaining funds directly to the publisher's connected Stripe account.
4.  Leverage Stripe for handling payouts, tax form generation (e.g., 1099-K in the US), and compliance aspects like seller verification (KYC).

## Publisher Onboarding & Verification Flow

This flow ensures that the publisher connecting their Stripe account is associated with the NPM package they intend to monetize.

1.  **Initiation:** A publisher expresses intent to monetize a specific MCP they publish on NPM (e.g., through a future MCPfinder web UI or a dedicated CLI command). They provide the NPM package name.
2.  **NPM Data Fetch:** MCPfinder fetches the package metadata from the NPM registry API for the given package name.
3.  **Extract Publisher Email:** MCPfinder extracts the publisher's email address from the NPM package data (e.g., `package.publisher.email`). This email is crucial for verification.
4.  **Stripe Connect Onboarding:**
    *   MCPfinder initiates the Stripe Connect onboarding flow (OAuth).
    *   The publisher is redirected to Stripe's website.
    *   The publisher either creates a new Stripe account or connects their existing one, granting MCPfinder permissions to create charges/transfers on their behalf.
5.  **Stripe Redirect & Account ID Retrieval:**
    *   Stripe redirects the publisher back to a pre-configured MCPfinder callback URL.
    *   MCPfinder receives an authorization code from Stripe.
    *   MCPfinder's backend exchanges this code with Stripe's API to securely obtain the publisher's unique Stripe Account ID (`acct_...`).
6.  **Email Verification:**
    *   MCPfinder generates a secure, time-limited verification code.
    *   MCPfinder sends an email containing this verification code to the `package.publisher.email` obtained from NPM in step 3.
    *   MCPfinder presents a page/prompt to the publisher asking them to enter the code they received via email.
7.  **Code Confirmation:**
    *   The publisher enters the verification code into the MCPfinder interface.
    *   MCPfinder validates the entered code against the one generated and sent.
8.  **Linkage & Storage:** Upon successful code verification, MCPfinder securely stores the link between the verified NPM package name, the publisher (potentially their MCPfinder user ID in the future), and their confirmed Stripe Account ID. This verified Stripe Account ID will be used for subsequent payment routing.

## Manifest Requirements for Paid MCPs

*   The `mcp.json` manifest for a paid MCP **must** include an optional `price` object:
    ```json
    {
      // ... other manifest fields
      "price": {
        "amount": 1000, // Amount in lowest currency unit (e.g., cents for USD)
        "currency": "usd" // Standard 3-letter ISO currency code
      }
      // ...
    }
    ```
*   MCPs without a `price` field are considered free to install.
*   The `publisherStripeAccountId` is **not** stored in the public manifest; it's stored internally and securely by MCPfinder after the verification process.

## User Purchase & Installation Flow

1.  **Identify Paid MCP:** The user attempts to install an MCP using the `add_mcp_server_config` tool (via an LLM in a client like Cursor). The tool (or the underlying `mcpfinder-server`) checks the MCP's manifest fetched from the registry. If a `price` field exists, it's identified as a paid MCP.
2.  **Initiate Payment:**
    *   The `mcpfinder-server` informs the user about the price.
    *   It calls a dedicated MCPfinder API endpoint (e.g., `POST /api/v1/create-payment-link`) providing the `mcp_id` (and potentially a user identifier in the future).
3.  **MCPfinder API Creates Payment Link:**
    *   The `/api/v1/create-payment-link` endpoint retrieves the MCP's `price` from its manifest and the *verified* `publisherStripeAccountId` associated with that MCP from MCPfinder's internal storage.
    *   It uses the Stripe API to create a **Stripe Checkout Session** or a **Payment Link**.
    *   The Stripe API call is configured for Destination Charges / Application Fee:
        *   `amount` and `currency` are set based on the MCP's `price`.
        *   `transfer_data[destination]` is set to the verified `publisherStripeAccountId`.
        *   `application_fee_amount` is set to MCPfinder's desired commission (calculated based on the price).
    *   The API endpoint returns the unique Stripe Checkout Session URL / Payment Link URL to the `mcpfinder-server`.
4.  **User Payment:**
    *   The `mcpfinder-server` tool presents the payment URL to the user.
    *   The user clicks the link, which opens Stripe's secure, hosted payment page in their browser.
    *   The user completes the payment using one of the methods offered by Stripe.
5.  **Payment Confirmation (Webhook):**
    *   Stripe sends an asynchronous webhook event (e.g., `checkout.session.completed`, `payment_intent.succeeded`) to a pre-configured MCPfinder API endpoint (e.g., `POST /api/v1/stripe-webhook`).
    *   The webhook handler in `api-worker` verifies the authenticity of the webhook event using Stripe's signature.
    *   It processes the event, extracts relevant details (like the associated MCP ID, user identifier if available, payment status), and records the successful purchase (e.g., in an `MCP_PURCHASES` KV namespace or database table).
    *   (Future) A unique license key/token could be generated and stored with the purchase record at this stage.
6.  **Installation Trigger:**
    *   The `add_mcp_server_config` tool needs a mechanism to know the payment succeeded. Options:
        *   **Polling:** Periodically call a status endpoint (`GET /api/v1/payment-status/{checkout_session_id}`) until it confirms success (less preferred due to delays and inefficiency).
        *   **State Change:** The webhook updates a status flag associated with the install request/user/MCP in KV/DB. The tool polls this internal state.
        *   **Real-time (Advanced):** Use WebSockets or similar for the API to push confirmation back to the waiting `mcpfinder-server` instance (more complex).
    *   Once payment confirmation is received, the `add_mcp_server_config` tool proceeds with the actual MCP server configuration/installation on the user's machine.
    *   (Future) If a license key was generated, it's passed to the MCP server's environment variables during installation.

## Payouts to Publishers

*   Stripe Connect automatically handles payouts to the publisher's connected Stripe account based on the schedule configured in their Stripe dashboard (e.g., daily, weekly, monthly).
*   MCPfinder does not need to manage payout schedules or initiate payout transfers.

## Security Considerations

*   **Publisher Identity:** Verification via the NPM publisher email adds a layer of assurance that the correct publisher is linking their Stripe account.
*   **API Keys:** MCPfinder's Stripe API keys must be kept secret and secure.
*   **Webhook Security:** Webhook endpoints must verify Stripe signatures to prevent spoofed events.
*   **Runtime Security (Future):** Implementing license key verification provides security *after* installation, ensuring only licensed users can run the paid MCP. The MCP server would call an MCPfinder API endpoint (`/api/v1/verify-license`) with its key for validation.

## Simplicity

*   **MCPfinder:** Offloads core payment complexity (processing, compliance, payouts, tax forms) to Stripe. Requires building the integration points (API endpoints, Connect onboarding, verification flow).
*   **Publishers:** Relatively simple onboarding (connect Stripe, verify email). Payouts are automatic.
*   **Users:** Familiar and secure Stripe checkout experience. Installation proceeds automatically after payment. 