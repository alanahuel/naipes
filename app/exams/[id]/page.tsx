import { ExamPage } from "@/components/exams";

export const dynamic = "force-dynamic";

/** One exam (a draft resumes its wizard here). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <ExamPage id={id} />;
}
