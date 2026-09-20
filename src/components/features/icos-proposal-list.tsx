import type { ReactNode } from "react";

export interface IcosProposal {
  id: number;
  title: string;
  status: string;
  color: string;
  icon?: ReactNode;
}

export default function IcosProposalList() {
  const proposals = [
    { id: 1, title: "Optimisation du funnel de vente", status: "awaiting approval", color: "purple", icon: "💡" },
    { id: 2, title: "Campagne de contenu LinkedIn", status: "draft", color: "purple", icon: "💡" },
    { id: 3, title: "Audit SEO technique", status: "planning", color: "purple", icon: "💡" },
  ];

  return (
    <section className="bg-white rounded-lg border p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">Propositions ICOS</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {proposals.map((proposal) => (
          <div key={proposal.id} className="border rounded-lg p-4 text-center">
            <div className="w-12 h-12 flex items-center justify-center bg-[var(--color, {proposal.color})-100] rounded mb-3">
              {proposal.icon ?? '💡'}
            </div>
            <h4 className="font-semibold">{proposal.title}</h4>
            <p className="text-xs text-gray-500">{proposal.status}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
