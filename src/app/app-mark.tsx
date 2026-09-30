/**
 * The Hub's mark as an image: the gold "S" tile of the header, edge to edge
 * (the phone applies its own corner mask). Plain inline styles — it is
 * rendered by next/og, not by the browser.
 */
export function AppMark({ size }: { size: number }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#e8c437",
        color: "#241b00",
        fontSize: size * 0.56,
        fontWeight: 800,
        letterSpacing: -size * 0.02,
      }}
    >
      S
    </div>
  );
}
