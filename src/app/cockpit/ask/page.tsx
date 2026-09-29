import { AskIcos } from "@/components/cockpit/ask-icos";
import { Panel } from "@/components/cockpit/primitives";
import { getCockpitContext } from "@/features/cockpit/load";

export const metadata = { title: "Ask ICOS" };

export default async function AskPage() {
  if (!(await getCockpitContext())) return null;
  return (
    <>
      <div className="cx-pagehead">
        <div>
          <p className="cx-eyebrow">Cognitive Runtime · conversation</p>
          <h1>Ask ICOS</h1>
        </div>
      </div>
      <Panel title="Conversation" eyebrow="ICOS answers; this screen only renders what it streams">
        <AskIcos />
      </Panel>
    </>
  );
}
