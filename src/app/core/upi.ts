export interface UpiPaymentRequest {
  payeeVpa: string;
  payeeName: string;
  amount?: number;
  note?: string;
}

/**
 * Builds a UPI deep link (NPCI "upi://pay" URI). The same string is encoded
 * into the QR code. It only *initiates* a payment - it never proves that a
 * payment succeeded.
 */
export function buildUpiUri(req: UpiPaymentRequest): string {
  const params: string[] = [
    `pa=${encodeURIComponent(req.payeeVpa.trim())}`,
    `pn=${encodeURIComponent(req.payeeName.trim())}`,
  ];
  if (req.amount !== undefined && req.amount > 0) {
    params.push(`am=${req.amount.toFixed(2)}`);
  }
  params.push('cu=INR');
  if (req.note) {
    // UPI apps truncate long notes; keep it short and free of special characters.
    const clean = req.note.replace(/[^A-Za-z0-9 \-/]/g, '').slice(0, 50);
    params.push(`tn=${encodeURIComponent(clean)}`);
  }
  return `upi://pay?${params.join('&')}`;
}

/** UTRs for UPI are 12 digits; bank references vary, so this is only a soft check. */
export function looksLikeUtr(ref: string): boolean {
  return /^\d{12}$/.test(ref.replace(/\s+/g, ''));
}
