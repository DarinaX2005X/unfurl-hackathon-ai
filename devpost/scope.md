---
doc: scope
status: draft
---
# Unfurl

A service that turns a learning goal into a researched, substantial course with varied interactive practice and an individual learning route.

## The Unique Kernel

A shared course has a stable set of learning outcomes and a different experience for each learner. The system researches and constructs the course, chooses exercises for the cognitive work they require, and adapts support and practice from evidence of the learner's work. It preserves the depth of the agreed curriculum.

Generating a syllabus alone is not the product's distinguishing claim. The proposed contribution must be visible in the generated activities, the quality of their feedback, and the learner's next meaningful action. Learning effectiveness remains an outcome to evaluate, not a claimed result.

## Who It's For

A self-directed learner who has a subject or practical goal and wants a substantial course combining explanations, experiments, practice, and independent application. They may begin without a curriculum. Existing alternatives include authored interactive courses, an AI tutor, and AI course generators. The service must earn use through the complete learning experience, not the mere presence of AI or a progress display.

A second entry is a learner opening a course shared by its creator. That learner receives their own progress and route while studying the same course version.

## The Core Loop

The creator describes a goal in an ordinary agent chat, discusses the proposed curriculum, and approves its structure. A conversation is independent of its results: one chat can create or edit several courses. A course exists only after the agent actually creates that artifact. The agent sets its title, summary, and content language from the conversation; the creator can then edit those details on the course. The agent researches each part, prepares and checks activities, and makes the course available in the library. The learner studies, attempts meaningful tasks, receives useful feedback, and returns to the next appropriate part of the course. A creator can share access by link. Learners who reach the required level can submit a course to the public catalog.

Conversation history and unfinished writing are retained automatically within their stated storage scope. Chat history belongs in the chat; the library contains actual courses and enrollments. Deleting a conversation does not implicitly delete its courses.

Adaptation may be a short explanation followed by continuation. It is not obliged to turn each error into a new exercise. Repeated practice or prerequisite work needs evidence and a clear route back to the common curriculum.

## Inspiration & Identity

The desired experience is expressive, tactile, readable, and enjoyable, with crafted motion on the landing and the internal work surfaces. The agent chat should remain familiar. The learning space should let the activity occupy the main stage instead of surrounding it with decorative dashboard panels.

The product is called Unfurl. Its brand slogan is "Learn what you've always wanted to". The hero pairs a fixed "Learn" with an automatically rotating, noninteractive topic pill; "everything" is one of many subjects. An unfolding study volume below the text gives the course a physical identity, with its pages becoming varied activities. Reduced motion keeps a readable static "Learn everything" and the scene's meaningful final state.

The interface is English only, while course language follows the conversation and can be edited on the created course. The composer has no language selector or manual save action. Public entry routes are `/`, `/explore`, `/library`, `/chat`, and `/try`, without a language prefix; `/create` remains a compatibility entry. The visual system uses warm paper surfaces, dark text, and a vermilion action color. Actual rendered visual quality remains to be reviewed.

## Why This Matters to the Learner

The creator chose the combination of making something from a prompt in minutes and learning through games. Their first requested course is deep AI: it starts with fundamentals, avoids padding, and continues into both creating models and building AI systems. This is a test of the course engine, not a reason to restrict the service to AI.

## What "Working" Looks Like

A new learning goal produces a usable, source-grounded curriculum, then a real course after the learner approves it. Its activities use the supported game components and meaningful grading. Two learners can study the same course while receiving different appropriate support, without silently losing required topics or depth. A learner can leave, return, continue, and open a shared course with separate progress.

The demonstration should show both creation and learning, including a meaningful change in the input or learner evidence and its actual consequence. A scripted generation animation does not count as a working result.

## The POC Boundary

The requested scope is a complete product rather than the minimum contest proof of concept. It includes a landing, catalog, personal library, creation chat with visible research actions, curriculum approval, course generation, many distinct game mechanics, learning progress, XP and levels, personal adaptation, sharing, and gated public publication. Several authored courses must be created through the same engine after the engine exists.

The learner has explicitly authorized starting the foundation and design while model access is pending. Model integration, durable shared services, and hosting must be verified before the complete service is described as ready.

## Later

A separate executor will create the presentation and demonstration video after the working product and README are handed over. This implementation does not produce those media. The hosting target is Vercel; production publication will use the agreed deployment arrangement.

## Explicitly Cut

No fabricated research events, fake generated courses, invented customer proof, or claims of measured learning gains. No arbitrary punishment or unnecessary tasks for a simple mistake. No isolated course hard-coded as a substitute for the general generation engine. No silent reduction of the requested product to a landing or a short quiz.
