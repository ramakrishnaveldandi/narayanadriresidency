import { derivePaymentStatus, findDuplicateRef, monthLabel, summarizeFlat, summarizeMonth } from './billing';
import type { MonthRecord, Payment } from './models';
import { buildUpiUri } from './upi';

function pay(p: Partial<Payment>): Payment {
  return { id: Math.random().toString(), month: '2026-10', flat: '101', amount: 0, paidAt: '2026-11-02', source: 'admin', verified: true, recordedAt: '', ...p };
}

const record: MonthRecord = {
  bill: {
    month: '2026-10',
    title: 't',
    columns: [],
    flats: [
      { flat: '101', values: {}, total: 1653 },
      { flat: '102', values: {}, total: 1909 },
      { flat: '103', values: {}, total: 1782 },
    ],
    source: { fileName: 'x', kind: 'excel', importedAt: '' },
    publishedAt: '',
    version: 1,
  },
  payments: [
    pay({ flat: '101', amount: 1000, txnRef: '111122223333' }),
    pay({ flat: '101', amount: 653 }),
    pay({ flat: '102', amount: 900 }),
    pay({ flat: '102', amount: 500, voided: true }),
    pay({ flat: '103', amount: 1782, verified: false, source: 'resident' }),
  ],
  audit: [],
};

describe('billing rules', () => {
  it('derives status with tolerance', () => {
    expect(derivePaymentStatus(1653, 0, 1)).toBe('Pending');
    expect(derivePaymentStatus(1653, 1000, 1)).toBe('Partially Paid');
    expect(derivePaymentStatus(1653, 1652.5, 1)).toBe('Paid');
    expect(derivePaymentStatus(1653, 2000, 1)).toBe('Paid');
  });

  it('sums multiple partial payments and ignores voided ones', () => {
    expect(summarizeFlat(record, '101', 1)).toMatchObject({ paid: 1653, outstanding: 0, status: 'Paid' });
    expect(summarizeFlat(record, '102', 1)).toMatchObject({ paid: 900, outstanding: 1009, status: 'Partially Paid' });
  });

  it('does not count unverified resident submissions as paid', () => {
    expect(summarizeFlat(record, '103', 1)).toMatchObject({ paid: 0, outstanding: 1782, status: 'Pending', awaitingVerification: 1782 });
  });

  it('summarises a month', () => {
    expect(summarizeMonth(record, 1)).toEqual({
      flatCount: 3, billed: 5344, collected: 2553, outstanding: 2791, paidCount: 1, partialCount: 1, pendingCount: 1,
    });
  });

  it('detects duplicate references regardless of spacing/case', () => {
    expect(findDuplicateRef(record.payments, ' 1111 2222 3333 ')?.flat).toBe('101');
    expect(findDuplicateRef(record.payments, '999')).toBeUndefined();
    expect(findDuplicateRef(record.payments, '')).toBeUndefined();
  });

  it('labels months', () => {
    expect(monthLabel('2026-10')).toBe('October 2026');
    expect(monthLabel('2026-10', true)).toBe('Oct 2026');
  });
});

describe('UPI URI', () => {
  it('pre-fills payee, amount and note', () => {
    const uri = buildUpiUri({ payeeVpa: 'Narayanadriassociation@oktgb', payeeName: 'Narayanadri Residency', amount: 1653, note: 'NR Maint Oct-2026 Flat 101' });
    expect(uri).toBe('upi://pay?pa=Narayanadriassociation%40oktgb&pn=Narayanadri%20Residency&am=1653.00&cu=INR&tn=NR%20Maint%20Oct-2026%20Flat%20101');
  });

  it('omits amount when not given', () => {
    expect(buildUpiUri({ payeeVpa: 'a@b', payeeName: 'X' })).toBe('upi://pay?pa=a%40b&pn=X&cu=INR');
  });
});
