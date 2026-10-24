"use client";

import { useId, useState } from "react";
import { Tabs } from "@/components/ui";
import { DATASET, fitPolynomial, type Degree } from "@/features/learning/sample/numerics";

const curves = ([1, 3, 7] as const).map((degree) => ({ degree, points: fitPolynomial(degree, 0.1).curve }));
const x = (value: number) => 58 + (value + 1) * 192;
const y = (value: number) => 154 - value * 87;
const connections = [
  { title: "A question", detail: "Be specific about what the system needs to help someone do." },
  { title: "Useful information", detail: "Bring in the information the model needs to answer that question." },
  { title: "A reasoned response", detail: "Check the result against the question, the evidence, and the limits of the system." },
] as const;

export function PracticePreview() {
  const [mode, setMode] = useState("experiment");
  const [degree, setDegree] = useState<Degree>(3);
  const [connection, setConnection] = useState(0);
  const [perspective, setPerspective] = useState("evidence");
  const id = useId().replaceAll(":", "");
  return <div className="landing-lab">
    <Tabs value={mode} onValueChange={setMode} label="Ways to practise" className="landing-lab__tabs" items={[
      { id: "experiment", label: "Experiment", panel: <div className="landing-lab__panel">
        <div className="landing-lab__copy"><h3>Change a model<br />See how it fits</h3><p>Choose how much freedom a model has. Compare its shape against the same eight data points.</p><fieldset className="landing-lab__choices"><legend>Model shape</legend>{([1, 3, 7] as const).map((value) => <label key={value}><input type="radio" name={`${id}-shape`} value={value} checked={degree === value} onChange={() => setDegree(value)} /><span>{value === 1 ? "Straight" : value === 3 ? "Curved" : "Flexible"}</span></label>)}</fieldset></div>
        <figure className="landing-lab__sheet"><svg viewBox="0 0 500 310" role="img" aria-label={`${degree === 1 ? "Straight" : degree === 3 ? "Curved" : "Flexible"} model fitted to eight example data points`}><defs><clipPath id={`${id}-plot`}><rect x="45" y="32" width="410" height="238" /></clipPath></defs><path d="M58 45v220h390" stroke="#B9AF99" fill="none" /><path d="M58 154h390" stroke="#DCD4C3" strokeDasharray="4 6" /><g clipPath={`url(#${id}-plot)`}>{curves.map((curve) => <path key={curve.degree} className="landing-lab__curve" data-visible={degree === curve.degree} d={curve.points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.x).toFixed(2)} ${y(point.y).toFixed(2)}`).join(" ")} stroke="#BA432D" fill="none" strokeWidth="4" strokeLinecap="round" />)}{DATASET.train.map((point) => <circle key={point.x} cx={x(point.x)} cy={y(point.y)} r="6" fill="#FFFEFA" stroke="#55664D" strokeWidth="3" />)}</g></svg><figcaption>The same data, a different model shape.</figcaption></figure>
      </div> },
      { id: "connect", label: "Connect", panel: <div className="landing-lab__panel">
        <div className="landing-lab__copy"><h3>Connect the parts<br />Follow the process</h3><p>An AI system is more than a model. Explore how a question, useful information, and a response belong together.</p><p className="landing-lab__hint">Choose a part to look closer.</p></div>
        <div className="landing-lab__sheet landing-lab__process"><div className="landing-lab__process-steps">{connections.map((item, index) => <button key={item.title} type="button" aria-pressed={connection === index} onClick={() => setConnection(index)}><span className="landing-lab__process-number">{index + 1}</span><span>{item.title}</span></button>)}</div><p className="landing-lab__process-detail">{connections[connection]?.detail}</p></div>
      </div> },
      { id: "explain", label: "Explain", panel: <div className="landing-lab__panel">
        <div className="landing-lab__copy"><h3>Make a choice<br />Explain your reasoning</h3><p>Consider the evidence behind a choice and the conditions where it might fail.</p><fieldset className="landing-lab__choices"><legend>Look for</legend>{[{ value: "evidence", label: "Evidence" }, { value: "limits", label: "Limits" }].map((option) => <label key={option.value}><input type="radio" name={`${id}-explanation`} value={option.value} checked={perspective === option.value} onChange={() => setPerspective(option.value)} /><span>{option.label}</span></label>)}</fieldset></div>
        <div className="landing-lab__sheet landing-lab__reason"><span className="landing-lab__quotation" aria-hidden="true">“</span><p>{perspective === "evidence" ? "What did you notice that supports your choice?" : "What would you need to check before trusting this result?"}</p><div className="landing-lab__reason-lines" aria-hidden="true"><span /><span /><span /></div></div>
      </div> },
    ]} />
  </div>;
}

