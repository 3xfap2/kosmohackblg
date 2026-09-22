import type { ReactNode } from "react";

// Словарь терминов кейса простыми словами — всплывает при наведении на подчёркнутое слово.
import { GLOSSARY } from "./glossary-terms";


export function Term({ k, children }: { k: keyof typeof GLOSSARY | string; children: ReactNode }) {
  return <span className="term" tabIndex={0} data-tip={GLOSSARY[k]}>{children}</span>;
}
