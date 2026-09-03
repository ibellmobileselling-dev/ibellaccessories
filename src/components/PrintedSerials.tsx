import { serialTextsOn } from "@/lib/serials";

/**
 * The unit numbers, under the item they belong to, on a printed document.
 *
 * This is the customer's half of the warranty. The shop can always look a
 * unit up, but when somebody comes back in eight months holding an adapter
 * and a piece of paper, the paper has to name the unit — otherwise the claim
 * comes down to whether the counter believes them.
 *
 * Deliberately plain: no colour, no box, no icon. These print on a
 * black-and-white bill and on a 58mm thermal roll, and anything decorative
 * either disappears or eats the width the numbers need.
 */
export function PrintedSerials({
  line,
  index,
  size = 9,
}: {
  line: { serialIds?: string[] };
  index?: Map<string, string>;
  size?: number;
}) {
  const serials = serialTextsOn(line, index);
  if (!serials.length) return null;
  return (
    <div
      style={{
        fontSize: size,
        // Monospace so a customer reading one out down the phone does not
        // confuse 0 with O or 1 with l — the two mistakes that turn a valid
        // warranty into an argument.
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        lineHeight: 1.35,
        wordBreak: "break-all",
        marginTop: 1,
      }}
    >
      S/N: {serials.join(", ")}
    </div>
  );
}
