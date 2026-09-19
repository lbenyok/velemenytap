import type { Metadata } from "next";
import { connection } from "next/server";
import { lookupPublicCard } from "@/features/feedback/card-lookup";
import { FeedbackFlow } from "@/features/feedback/feedback-flow";
import { PublicMessageScreen } from "@/features/feedback/public-message-screen";

export const metadata: Metadata = { title: "Oszd meg a véleményed" };

export default async function PublicFeedbackPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  // Card status is checked for each visit, never captured in a static page.
  await connection();
  const { publicId } = await params;
  const card = await lookupPublicCard(publicId);

  if (!card) {
    return (
      <PublicMessageScreen
        title="Ez a link nem működik"
        description="Nem találjuk ezt a véleménykártyát. Kérj segítséget a személyzettől."
      />
    );
  }

  if (!card.isActive) {
    return (
      <PublicMessageScreen
        title="Ez a kártya inaktív"
        description="Ez a VéleményTap kártya jelenleg nem aktív."
      />
    );
  }

  return (
    <FeedbackFlow
      publicId={publicId}
      organizationName={card.organizationName}
      locationName={card.locationName}
      googleReviewUrl={card.googleReviewUrl}
    />
  );
}
