# TASKS

Version: v0.1

This file is the implementation roadmap for the WhatsApp Bookkeeping Assistant.

Rule:

Only ONE task should be worked on at a time.

Do not begin another task until the current one is complete and tested.

---

# PHASE 1 — Project Foundation

## Task 1

Create a production-ready Node.js project.

Requirements

- Express.js
- Environment variables
- ESLint
- Prettier
- Clean folder structure
- Git initialized
- Basic README

Deliverable

Project starts successfully.

---

## Task 2

Create the folder structure.

Required folders

src/

config/

controllers/

routes/

services/

models/

middleware/

utils/

prompts/

whatsapp/

transcription/

pdf/

statement/

validators/

Deliverable

Folder structure exists.

No business logic yet.

---

## Task 3

Connect MongoDB.

Requirements

Connection using Mongoose.

Graceful connection errors.

Environment variables.

Deliverable

Application connects successfully.

---

# PHASE 2 — WhatsApp

## Task 4

Create Meta WhatsApp webhook.

Requirements

Webhook verification.

Receive text.

Receive voice.

Extract sender number.

Deliverable

Incoming messages appear in server logs.

---

## Task 5

Download voice notes.

Deliverable

Voice file is successfully downloaded.

---

## Task 6

Integrate Whisper.

Requirements

Convert audio to text.

Handle transcription failures.

Deliverable

Voice note becomes plain text.

---

# PHASE 3 — AI

## Task 7

Build Message Classification Service.

Possible results

LOG_ENTRY

QUERY

CONFIRMATION

CORRECTION

Deliverable

Incoming message classified correctly.

---

## Task 8

Build Transaction Parser.

Extract

- income / expense
- property
- amount
- category
- description
- transaction date

Never guess.

Return clarification request if uncertain.

Deliverable

Correct JSON returned.

---

## Task 9

Create Pending Draft Service.

Requirements

Store draft.

One pending draft per WhatsApp user.

Deliverable

Draft saved in MongoDB.

---

## Task 10

Confirmation Flow.

If user replies YES

↓

Save entry

Delete pending draft

If correction

↓

Update draft

Ask again

Deliverable

Confirmation workflow complete.

---

# PHASE 4 — Database

## Task 11

Create Entry model.

Requirements

Validation.

Indexes.

CreatedAt.

TransactionDate.

ConfirmedAt.

Status.

Deliverable

Entries save correctly.

---

## Task 12

Support

Undo last entry

Edit last entry

Delete last entry

Deliverable

Entries can be safely corrected.

---

# PHASE 5 — Queries

## Task 13

Build Query Service.

Support

Income this month.

Expenses this month.

Net amount.

Expenses by category.

Property totals.

Last transactions.

Deliverable

Natural-language questions answered using stored data only.

---

# PHASE 6 — PDF

## Task 14

Generate monthly PDF.

Include

Property.

Date range.

Income.

Expenses.

Category totals.

Net amount.

Itemized transactions.

Deliverable

Investor-ready PDF.

---

## Task 15

Send PDF to WhatsApp.

Deliverable

PDF received as document.

---

# PHASE 7 — Testing

## Task 16

Test

Text logging.

Voice logging.

Clarification.

Confirmation.

Corrections.

Queries.

PDF generation.

Undo.

Duplicate detection.

Deliverable

Everything works.

---

# PHASE 8 — Deployment

## Task 17

Deploy backend.

Configure

Environment variables.

Webhook URL.

MongoDB.

WhatsApp credentials.

Deliverable

Pilot user can use the assistant.