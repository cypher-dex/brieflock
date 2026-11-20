import './globals.css';

export const metadata = {
  title: 'BriefLock · pay to unlock on Fiber',
  description: 'Sell a research brief and get paid on Fiber Testnet. The payment reveals the key that unlocks it.',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
