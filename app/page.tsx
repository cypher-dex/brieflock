'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptResult, toHex } from '../lib/crypto';
import {
  MAX_AUTHOR, MAX_FILE_BYTES, MAX_PRICE_CKB, MAX_TEASER, MAX_TITLE, MIN_PRICE_CKB,
  base64ToBytes, bytesToBase64, draftProblem, formatBytes, formatCkb, parseSecret, priceToShannons,
  verifyFingerprint, type BriefDraft, type BriefSecret,
} from '../lib/brief';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createOffer, parseOffer, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';

type Role = 'buyer' | 'seller';
const ckb = (value: string) => formatCkb(BigInt(value));

const sampleDraft: BriefDraft = {
  title: 'Notes on paying over Fiber',
  author: 'Karas',
  teaser: 'What i learned after a week of trying Fiber payments on testnet: what worked, what broke, and what i would build first.',
  priceCkb: 2,
  body: [
    'Notes on paying over Fiber (full version)',
    '',
    '1. Opening a channel takes a few minutes. Do it first and wait for CHANNEL_READY.',
    '2. Keep some extra CKB in the wallet, the channel needs more than the 500 CKB you put in.',
    '3. Small payments are cheap. My 2 CKB test cost 0.002 CKB in routing fee.',
    '4. Pay to unlock is the easiest thing to build first, because the payment gives you the key.',
  ].join('\n'),
};

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  const [draft, setDraft] = useState<BriefDraft>(sampleDraft);
  const [generated, setGenerated] = useState('');
  const [received, setReceived] = useState('');
  const [offer, setOffer] = useState<EncryptedOffer | null>(null);
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [unlocked, setUnlocked] = useState<{ secret: BriefSecret; verified: boolean } | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) { setGenerated(saved.generatedOffer); setReceived(saved.buyerOfferText); setAttempt(saved.attemptedPaymentHash); setTested(saved.triedWithoutKey); }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {}; };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a transfer.'); }
    finally { locked.current = false; setBusy(false); }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return false;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    const linked = peers.some(peer => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2));
    setConnected((previous) => ({ ...previous, [role]: linked }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
    return linked;
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    const hasChannel = Boolean(await readChannel(started));
    if (hasChannel) await started.connectPeer(bottle);
    let linked = await refresh(role);
    // the handshake with Bottle can finish a bit after connectPeer returns
    for (let attempt = 0; hasChannel && !linked && attempt < 8; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      linked = await refresh(role);
    }
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({ target_pubkey: bottle.pubkey, amount: '0x1dcd65000', keysend: true });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Liquidity transfer: ${result.status}`);
    await refresh('seller');
  }

  async function makeOffer() {
    const problem = draftProblem(draft);
    if (problem) throw new Error(problem);
    if (!nodes.current.seller || !channels.seller || !sellerRouteReady(draft.priceCkb) || generated || attempt) return;
    const value = await createOffer(nodes.current.seller, channels.seller, draft);
    save({ generatedOffer: value }); setGenerated(value); setStatus('Locked. Copy the offer to the buyer.');
  }

  async function attachFile(file: File | undefined) {
    if (!file) { setDraft((previous) => ({ ...previous, file: undefined })); return; }
    if (file.size > MAX_FILE_BYTES) {
      setError(`Attachment is limited to ${formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }
    const base64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    setError('');
    setDraft((previous) => ({ ...previous, file: { name: file.name, type: file.type || 'application/octet-stream', base64 } }));
  }

  async function validate() {
    if (!nodes.current.buyer) return;
    const parsed = parseOffer(received);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    save({ buyerOfferText: received }); setOffer(parsed); setStatus('Offer looks fine.');
  }

  async function testLock() {
    if (!offer) return;
    try { await decryptResult(offer, toHex(crypto.getRandomValues(new Uint8Array(32)))); }
    catch { save({ triedWithoutKey: true }); setTested(true); setStatus('Decryption rejected: key unavailable.'); }
  }

  async function pay() {
    if (!nodes.current.buyer || !offer || !tested || !buyerRouteReady(offer.brief.priceCkb)) return;
    const result = await payForOffer(nodes.current.buyer, offer, attempt, (hash) => {
      save({ attemptedPaymentHash: hash }); setAttempt(hash);
    }, payment?.status === 'Failed');
    acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  function acceptPayment(result: GetPaymentResult) {
    setPayment(result); setStatus(`Payment: ${result.status}`);
    if (result.status === 'Failed') setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    if (result.status === 'Success' && result.payment_preimage) setKey(result.payment_preimage);
  }

  async function checkPayment() {
    if (!nodes.current.buyer || !offer || !attempt) return;
    await validateOffer(nodes.current.buyer, offer);
    acceptPayment(await nodes.current.buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  async function unlock() {
    if (!offer || !key) return;
    const text = await decryptResult(offer, key);
    const secret = parseSecret(text);
    const verified = await verifyFingerprint(text, offer.brief);
    setUnlocked({ secret, verified });
    setStatus(verified ? 'Unlocked. Fingerprint matches.' : 'Unlocked, but the fingerprint does not match the offer.');
  }

  function download() {
    const file = unlocked?.secret.file;
    if (!file) return;
    const url = URL.createObjectURL(new Blob([base64ToBytes(file.base64)], { type: file.type }));
    const link = document.createElement('a');
    link.href = url; link.download = file.name; link.click();
    URL.revokeObjectURL(url);
  }

  function startAnotherOffer() {
    if (busy || (attempt && payment?.status !== 'Failed')) return;
    save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, completedSteps: [] });
    setGenerated(''); setReceived(''); setOffer(null); setAttempt(''); setTested(false);
    setPayment(null); setKey(''); setUnlocked(null); setError('');
    setStatus('Ready for a new brief.');
  }

  const buyerRouteReady = (priceCkb: number) => Boolean(connected.buyer && channels.buyer && ready(channels.buyer)
    && BigInt(channels.buyer.local_balance) >= priceToShannons(priceCkb) + 100_000_000n);
  const sellerRouteReady = (priceCkb: number) => Boolean(connected.seller && channels.seller && ready(channels.seller)
    && BigInt(channels.seller.remote_balance) >= priceToShannons(priceCkb));
  const price = offer?.brief.priceCkb ?? draft.priceCkb;
  const routeReady = buyerRouteReady(price) && sellerRouteReady(price);
  const draftError = draftProblem(draft);
  const canSubmit = Boolean(offer && tested && routeReady && !key && (!attempt || payment?.status === 'Failed'));
  const set = <K extends keyof BriefDraft>(field: K, value: BriefDraft[K]) => setDraft((previous) => ({ ...previous, [field]: value }));

  return <main>
    <header className="hero">
      <p className="eyebrow">BriefLock · Fiber Testnet</p>
      <h1>Pay to unlock a research brief</h1>
      <p className="lede">The seller writes a brief with a free preview. The full text (and a file, if you want) gets locked with a key. The buyer pays over Fiber and the payment gives the key back. No backend, testnet only.</p>
    </header>
    {status && <p className="status" role="status">{status}</p>}{error && <p className="alert" role="alert">{error}</p>}

    <h2 className="step">1. Start the nodes</h2>
    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h3>{role === 'buyer' ? 'Buyer A' : 'Seller C'}</h3>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB ↗</a>
        {!channels[role] && <p className="hint">{channelFundingGuidance}</p>}
        <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
        <button disabled={busy} onClick={() => void run(async () => { await refresh(role); })}>Refresh channel status</button>
      </>}
      {channels[role] && <><code>{channels[role].state.state_name}</code><p className="hint">{role}: {ckb(channels[role].local_balance)} CKB · Bottle: {ckb(channels[role].remote_balance)} CKB</p></>}
    </section>)}</div>
    <section className="card"><h3>Liquidity (optional)</h3>
      <p className="hint">Only needed if a payment fails for lack of liquidity. A new channel already works up to {MAX_PRICE_CKB} CKB.</p>
      <button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button></section>

    <h2 className="step">2. Lock a brief, then pay for it</h2>
    <div className="grid exchange">
      <section className="card"><h3>Seller C</h3>
        <label>Title<input value={draft.title} maxLength={MAX_TITLE} disabled={busy || Boolean(generated)} onChange={e => set('title', e.target.value)} /></label>
        <div className="row">
          <label>Author<input value={draft.author} maxLength={MAX_AUTHOR} disabled={busy || Boolean(generated)} onChange={e => set('author', e.target.value)} /></label>
          <label>Price (CKB)<input type="number" min={MIN_PRICE_CKB} max={MAX_PRICE_CKB} step={1} value={draft.priceCkb} disabled={busy || Boolean(generated)} onChange={e => set('priceCkb', Number(e.target.value))} /></label>
        </div>
        <label>Free preview <span className="count">{draft.teaser.length}/{MAX_TEASER}</span><textarea className="short" aria-label="Free preview" value={draft.teaser} maxLength={MAX_TEASER} disabled={busy || Boolean(generated)} onChange={e => set('teaser', e.target.value)} /></label>
        <label>Full brief (locked)<textarea aria-label="Locked brief" value={draft.body} disabled={busy || Boolean(generated)} onChange={e => set('body', e.target.value)} /></label>
        <label>File (optional, max {formatBytes(MAX_FILE_BYTES)})<input type="file" disabled={busy || Boolean(generated)} onChange={e => void attachFile(e.target.files?.[0])} /></label>
        {draft.file && <p className="hint">Attached: {draft.file.name} (locked with the text)</p>}
        {draftError && !generated && <p className="hint warn">{draftError}</p>}
        <button disabled={busy || Boolean(draftError) || !sellerRouteReady(draft.priceCkb) || Boolean(generated || attempt)} onClick={() => void run(makeOffer)}>Lock brief ({draft.priceCkb} CKB invoice)</button>
        <label>Offer (send this to the buyer)<textarea aria-label="Generated offer" readOnly value={generated} /></label>
        <button disabled={!generated || busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(generated); setStatus('Offer copied.'); })}>Copy offer</button>
      </section>

      <section className="card"><h3>Buyer A</h3>
        <label>Paste the offer<textarea aria-label="Received offer" disabled={busy || Boolean(offer || attempt)} value={received} onChange={e => { setReceived(e.target.value); setTested(false); }} /></label>
        <button disabled={busy || !received || !addresses.buyer || Boolean(offer)} onClick={() => void run(validate)}>Validate offer</button>
        {offer && <article className="preview" aria-label="Offer preview">
          <p className="eyebrow">Free preview</p>
          <h4>{offer.brief.title}</h4>
          <p className="byline">{offer.brief.author ? `by ${offer.brief.author} · ` : ''}{offer.brief.priceCkb} CKB to unlock{offer.brief.file ? ` · includes ${offer.brief.file.name} (${formatBytes(offer.brief.file.size)})` : ''}</p>
          <p>{offer.brief.teaser}</p>
          <p className="fingerprint">Content fingerprint (SHA-256) <code>{offer.brief.contentHash}</code></p>
        </article>}
        {!tested && <button disabled={busy || !offer} onClick={() => void run(testLock)}>Decrypt without key</button>}
        {canSubmit && <button disabled={busy} onClick={() => void run(pay)}>{attempt ? 'Retry failed payment' : `Pay ${offer?.brief.priceCkb} CKB to unlock`}</button>}
        {attempt && !key && <button disabled={busy || !offer || !addresses.buyer} onClick={() => void run(checkPayment)}>Check payment status</button>}
        <button disabled={busy || !offer || !key || Boolean(unlocked)} onClick={() => void run(unlock)}>Unlock</button>
      </section>
    </div>

    {payment?.status === 'Success' && offer && <section className="card receipt"><h3>Receipt</h3><p>Price: {offer.brief.priceCkb} CKB · Routing fee: {ckb(payment.fee)} CKB · Total: {formatCkb(priceToShannons(offer.brief.priceCkb) + BigInt(payment.fee))} CKB</p><span className="label">Payment hash</span><code>{payment.payment_hash}</code></section>}
    {unlocked && offer && <section className="result"><h3>{offer.brief.title}</h3>
      <p className={unlocked.verified ? 'verified' : 'warn'}>{unlocked.verified ? '✓ Fingerprint matches the offer.' : 'Fingerprint does not match the offer.'}</p>
      <pre>{unlocked.secret.body}</pre>
      {unlocked.secret.file && <button onClick={download}>Download {unlocked.secret.file.name}</button>}
    </section>}
    {(generated || received) && (!attempt || payment?.status === 'Failed') && <button disabled={busy} onClick={() => void run(async () => startAnotherOffer())}>Start another brief</button>}
    <footer className="foot">Testnet only, dont use real keys or mainnet CKB.</footer>
  </main>;
}
