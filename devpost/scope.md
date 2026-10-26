---
doc: scope
status: draft
---
# Unfurl

A learning workspace that turns a personal goal into a researched, substantial course, then supports study through varied interactive practice.

## The Unique Kernel

The difficult part is the relationship between a learning goal and a useful activity. Unfurl researches the subject, forms an editable curriculum, checks the approved outcomes against teaching knowledge, and constructs exercises with explicit criteria and supported interaction capabilities.

A shared course version preserves its outcomes. Each learner has separate answers, evidence, progress, and a route through additional support. The product's contribution must be visible in the quality of the generated activities and feedback, not merely in a syllabus or a progress animation. Learning effectiveness remains an outcome to measure.

## Who It's For

Self-directed learners who have a subject or practical goal but need a coherent sequence of explanations, experiments, practice, and application. They may create a course themselves or enter a course shared by someone else.

Unfurl is not restricted to AI. The substantial course used to exercise the system is an English AI curriculum, starting with foundations and continuing into both model creation and AI-system engineering.

## The Core Loop

1. Describe the desired ability and relevant background in an account-backed chat.
2. Discuss the agent's research and inspect the saved curriculum beside the conversation.
3. Edit the selected course's program or details, then approve its exact current revision.
4. Continue following the build in the same chat: section research, knowledge coverage, lesson planning, writing, task construction, and validation.
5. Start a ready version from the course or library, perform meaningful activities, review feedback, and continue from saved progress.
6. Use additional support when relevant, or request review of uncertain feedback.
7. Share a version through a revocable link, or publish a ready version once the account meets the publication requirement.

One chat can contain several course artifacts. Chat history belongs in chat; the library contains courses and enrollments. Deleting a conversation does not implicitly delete its courses. An unsent first draft creates no server conversation until Send.

## Inspiration & Identity

Unfurl combines the usefulness of making something from a prompt with the satisfaction of learning through interaction. The slogan is **Learn what you've always wanted to**.

Warm paper, dark readable type, and a vermilion action color connect the landing, creator, and player. The unfolding study volume expresses one coherent course becoming varied activities. The hero's rotating topic is noninteractive; reduced motion keeps a stable readable state. Internal surfaces favor the current task and clear feedback over decorative dashboards.

The interface is English. Course language follows the conversation and is editable on the course artifact. Main entry routes are `/`, `/chat`, `/explore`, `/library`, and `/try`.

## Why This Matters to the Learner

A learner should be able to judge the proposed learning path before detailed construction starts, understand what the system is doing during long work, and receive practice that calls for more than recognizing a memorized answer. Returning to a course should preserve both the shared material and the learner's own work.

Alternatives include authored interactive courses, a general AI tutor, and course generators. Unfurl must earn use through connected research, course quality, meaningful activity, and durable personal progress; the presence of AI alone is not the benefit.

## What "Working" Looks Like

A real goal produces a researched curriculum and, after approval, a validated ready course. Changes to the request affect the program. Actual learner actions affect evaluation and support. Two learners retain separate progress in the same immutable version. Leaving, returning, sharing, and revoking access behave consistently.

Ready content must be backed by validation, not an optimistic UI state. An uncertain evaluator result earns no XP. A failed external call remains visible without erasing accepted work or pretending it was free.

The current repository includes the implementation and automated tests for these boundaries. Acceptance of the complete generated course, genuine learning, publication, and featured entry requires the separate checks in the [verification checklist](checklist.md); a draft screenshot does not close them.

## The POC Boundary

The scope is a complete service: landing, accounts, catalog, library, creator chat, research, approval, course construction, 29 activity families, saved learning, XP and levels, personal support, sharing, and gated publication.

The authored-content scope is **one full AI course**, created through the ordinary product workflow. Both model-building and AI-system branches remain in that course. Additional history and statistics courses are excluded from this delivery. The implementation is not reduced to a short quiz or an isolated sample.

Services are Supabase Auth/PostgreSQL, OpenRouter, and Vercel Workflow/Sandbox. Configuration, verified runtime capabilities, provider availability, and server-side accounting are real operating requirements. See [setup](../docs/setup.md).

## Later

A separate assignment produces the presentation and demonstration video after the working product and documentation are handed over. This repository does not include placeholder links or claim those media are complete.

## Explicitly Cut

No fabricated research, hard-coded course substituted for generation, fake XP, invented testimonials, or measured-learning claims. No forced remedial detour for every small error. No hidden reduction of approved outcomes, exposure of private answer keys, or browser-reported success treated as authoritative grading.
