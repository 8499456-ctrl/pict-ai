# PictTool

## Paddle subscription checkout

The Worker accepts Paddle Billing notifications at:

`https://www.picttool.com/api/paddle/webhook`

Configure these Cloudflare secrets before deploying:

```sh
wrangler secret put PADDLE_CLIENT_TOKEN
wrangler secret put PADDLE_WEBHOOK_SECRET
wrangler secret put FEEDBACK_ADMIN_TOKEN
```

The client-side token must be a Sandbox `test_` token while testing and a Live
`live_` token only after the Paddle account is approved for production. The
current Sandbox price is:

`pri_01m0kr1wzwzgp45w082thzcyaz`

Paddle.js opens the monthly checkout for the signed-in Supabase user and sends
the Supabase user ID and email as `custom_data`. The Worker verifies the
`Paddle-Signature` header, ignores duplicate notification IDs, stores
subscription status, and adds 300 credits when a `transaction.completed`
notification arrives.

Configure a Paddle notification destination for the endpoint and subscribe to:

- `subscription.created`
- `subscription.updated`
- `subscription.canceled`
- `subscription.past_due`
- `transaction.completed`
- `transaction.payment_failed`

The private admin endpoint is:

`GET /api/billing` with the `X-Pict-Admin-Token` header.
