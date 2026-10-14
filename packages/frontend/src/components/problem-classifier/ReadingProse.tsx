/**
 * Pass 2 writes prose with three section headings. The model sometimes emits
 * them as markdown (`## Payment`, `**Payment**`) and sometimes as a bare short
 * line, so both are recognised and used as section labels; everything else is
 * a paragraph, verbatim.
 *
 * Presentation is a case file: the label sits in the left margin on a wide
 * screen and above the prose on a narrow one, and the prose itself is the only
 * serif on the page.
 */
function headingText(block: string): string | null {
  const hashed = block.match(/^#{1,6}\s+(.+)$/);
  if (hashed) return hashed[1].trim();

  const bolded = block.match(/^\*\*(.+)\*\*$/);
  if (bolded) return bolded[1].trim();

  const isSingleLine = !block.includes('\n');
  const words = block.trim().split(/\s+/);
  if (isSingleLine && words.length <= 12 && block.length <= 90 && !/[.,;:?!]$/.test(block.trim())) {
    return block.trim();
  }
  return null;
}

interface Section {
  label: string | null;
  paragraphs: string[];
}

/** Groups the blocks into labelled sections, keeping the model's order. */
function toSections(text: string): Section[] {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== '');
  const sections: Section[] = [];

  for (const block of blocks) {
    const label = headingText(block);
    if (label) {
      sections.push({ label, paragraphs: [] });
      continue;
    }
    if (sections.length === 0) sections.push({ label: null, paragraphs: [] });
    sections[sections.length - 1].paragraphs.push(block);
  }

  return sections;
}

export function ReadingProse({ text }: { text: string }) {
  return (
    <div className="space-y-7">
      {toSections(text).map((section, i) => (
        <section key={i} className="pc-labelled">
          <h3 className="pc-dim pt-1 text-[13px] font-normal">{section.label ?? ''}</h3>
          <div className="space-y-4">
            {section.paragraphs.map((p, j) => (
              <p key={j} className="pc-reading whitespace-pre-wrap font-serif">
                {p}
              </p>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
