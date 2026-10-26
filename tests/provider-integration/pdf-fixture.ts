/** A reproducible PDF fixture built locally, with no downloaded/copyrighted
 * material, native binary generator or private workspace dependency. */
export function pdfFixture(pages:readonly string[],options:{title?:string; paddingBytes?:number}={}):Uint8Array{
  const escape=(value:string)=>value.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
  const objects:string[]=["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_,i)=>`${4+i*2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for(const [index,text]of pages.entries()){
    const lines:string[]=[];
    for(let start=0;start<text.length;){let end=Math.min(start+1000,text.length);if(end<text.length){const space=text.lastIndexOf(" ",end);if(space>start)end=space+1;}lines.push(text.slice(start,end));start=end;}
    const stream=`BT /F1 1 Tf 2 TL 40 14360 Td ${lines.map(line=>`(${escape(line)}) Tj T*`).join("\n")} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+index*2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream,"ascii")} >>\nstream\n${stream}\nendstream`);
  }
  const info=objects.push(`<< /Title (${escape(options.title??"Unfurl PDF source fixture")}) >>`);
  let pdf="%PDF-1.7\n";
  if(options.paddingBytes)pdf+=`%${"p".repeat(options.paddingBytes)}\n`;
  const offsets=[0];
  for(const [i,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf,"ascii"));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(pdf,"ascii");
  pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf,"ascii"));
}
