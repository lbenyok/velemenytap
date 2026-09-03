import type { Metadata } from "next";
import { lookupPublicCard } from "@/features/feedback/card-lookup";
import { FeedbackFlow } from "@/features/feedback/feedback-flow";
import { PublicMessageScreen } from "@/features/feedback/public-message-screen";

export const metadata: Metadata = { title: "Share your feedback" };

export default async function PublicFeedbackPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const card = await lookupPublicCard(publicId);

  if (!card) {
    return (
      <PublicMessageScreen
        title="This link doesn't work"
        description="We couldn't find this feedback card. Ask a staff member to check it."
      />
    );
  }

  if (!card.isActive) {
    return (
      <PublicMessageScreen
        title="This card is inactive"
        description={`${card.organizationName} isn't using this feedback card right now.`}
      />
    );
  }

  return (
    <FeedbackFlow
      publicId={publicId}
      organizationName={card.organizationName}
      locationName={card.locationName}
    />
  );
}
