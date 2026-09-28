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
          <p className="cx-eyebrow">Natural-language command</p>
          <h1>Ask ICOS</h1>
        </div>
      </div>
      <Panel title="Command surface" eyebrow="The backend decides; this screen asks">
        <AskIcos />
      </Panel>
    </>
  );
}
