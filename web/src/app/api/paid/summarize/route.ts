import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import {
  decodeHeader,
  encodeHeader,
  HEADER_AGENT,
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  type PaymentPayload,
} from "@aevum-kit/aevum";
import { createQuote, hashBody, SellerError, settle, toSellerError } from "@/lib/seller";
import { summarize } from "@/lib/summarize";

/**
 * Paid endpoint: POST { "text": "..." } and get a summary, for one tUSD8 micropayment.
 *   - No X-Payment header: 402 with a quote for this exact request.
 *   - X-Payment (base64 JSON PaymentPayload): verified, settled on Aevum, then served.
 * See packages/aevum/src/payment.ts for the protocol.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TEXT = 20_000;
const RESOURCE = "/api/paid/summarize";

function fail(e: SellerError) {
  return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
}

export async function POST(req: Request) {
  try {
    const raw = await req.text();
    let text: unknown;
    try {
      text = (JSON.parse(raw) as { text?: unknown }).text;
    } catch {
      throw new SellerError(400, 'Send JSON: { "text": "..." }.', "bad_request");
    }
    if (typeof text !== "string" || !text.trim()) throw new SellerError(400, 'Send JSON: { "text": "..." }.', "bad_request");
    if (text.length > MAX_TEXT) throw new SellerError(413, `Text is limited to ${MAX_TEXT} characters.`, "too_large");

    const agentHeader = req.headers.get(HEADER_AGENT)?.trim();
    if (!agentHeader || !isAddress(agentHeader)) {
      throw new SellerError(400, `Send your agent address in the ${HEADER_AGENT} header.`, "no_agent");
    }
    const agent = agentHeader as Address;
    const bodyHash = hashBody(raw);
    const paymentHeader = req.headers.get(HEADER_PAYMENT);

    if (!paymentHeader) {
      const quote = await createQuote(agent, RESOURCE, bodyHash);
      return NextResponse.json({ error: "Payment required", accepts: [quote] }, { status: 402 });
    }

    const payload = decodeHeader<PaymentPayload>(paymentHeader);
    if (!payload || payload.scheme !== "vault-sig" || !payload.quoteId || !payload.signature || !isAddress(payload.agent)) {
      throw new SellerError(400, `The ${HEADER_PAYMENT} header is not a valid payment.`, "bad_payment");
    }
    if (payload.agent.toLowerCase() !== agent.toLowerCase()) {
      throw new SellerError(400, `The ${HEADER_PAYMENT} agent does not match the ${HEADER_AGENT} header.`, "agent_mismatch");
    }

    const { result, payment, replay } = await settle(payload, bodyHash, async () => summarize(text as string));
    return NextResponse.json(
      { result, payment, replay },
      { status: 200, headers: { [HEADER_PAYMENT_RESPONSE]: encodeHeader(payment) } },
    );
  } catch (e) {
    return fail(toSellerError(e));
  }
}
