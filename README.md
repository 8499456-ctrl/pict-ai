# PictTool

## Stripe subscription webhook

The Worker accepts Stripe subscription events at:

`https://www.picttool.com/api/stripe/webhook`

Configure these Cloudflare secrets before deploying:

```sh
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put FEEDBACK_ADMIN_TOKEN
```

In Stripe Workbench, create a webhook for the endpoint and select:

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`

The Worker verifies Stripe signatures, ignores duplicate event IDs, stores subscription status, and adds 300 credits when a new invoice is paid. The private admin endpoint is:

`GET /api/billing` with the `X-Pict-Admin-Token` header.

This first version stores billing records in the existing Durable Object. The later Supabase integration should use the stored Stripe customer/subscription IDs to bind those records to the authenticated user ID.
