# PROJECT CONTEXT

Version: v0.1
Status: Active Development
Primary Developer: [Your Name]
Primary User: One real property manager (pilot user)
Last Updated: July 2026

---

# Product Name

WhatsApp Bookkeeping Assistant

---

# Product Overview

WhatsApp Bookkeeping Assistant is an AI-powered bookkeeping assistant built specifically for independent property managers who manage rental properties on behalf of investor-owners.

Instead of maintaining spreadsheets, the property manager simply sends text messages or voice notes through WhatsApp describing money received or money spent.

The assistant converts those conversations into structured bookkeeping records.

The assistant can also answer bookkeeping questions using previously saved records and generate investor-ready PDF statements for individual properties.

Version 0.1 is intentionally limited to a single real user and a known list of properties in order to validate the product before expanding its scope.

---

# Problem Statement

The pilot user currently tracks income and expenses manually.

At the end of every month she reconstructs financial activity from:

- Memory
- WhatsApp chats
- Receipts
- Bank transfers
- Cash payments
- Manual spreadsheets

This process is slow, repetitive and mentally exhausting.

It is also easy to miss transactions or make mistakes.

The goal of this product is NOT to replace accounting software.

The goal is to remove the manual effort of recording transactions and preparing investor reports.

---

# Target User

This product is designed for exactly one type of user.

Independent property managers.

Characteristics:

- Manages apartments for investors
- Does not own the apartments
- Collects rent
- Pays maintenance expenses
- Reports monthly to investors
- Uses WhatsApp constantly
- Is not an accountant
- Wants speed more than advanced accounting features
- Values accuracy more than automation

---

# Product Goal

Allow the user to manage bookkeeping entirely from WhatsApp.

The user should never need to open a spreadsheet during daily operations.

The product should become the default place where every financial transaction is recorded.

---

# Core Philosophy

## WhatsApp First

Everything happens inside WhatsApp.

No dashboard.

No mobile app.

No website.

No login.

---

## Natural Language First

Users speak naturally.

The software understands them.

The software should never require special commands.

Good:

"Paid plumber 18k for Apartment 2."

Bad:

Expense
Category
Property
Amount

---

## Trust Before Automation

Trust is the most important feature.

The assistant must never invent bookkeeping data.

The assistant must never estimate missing information.

The assistant must never guess.

---

## Confirmation Before Saving

No transaction is ever saved automatically.

Every transaction must be approved by the user before entering the database.

This rule is non-negotiable.

---

# Product Principles

The following principles should guide every future feature.

- Simplicity beats complexity.
- Accuracy beats speed.
- Conversation beats forms.
- Human approval beats automation.
- One clear answer is better than five vague paragraphs.
- Every answer must come from real stored data.
- Never fabricate information.
- Never hide uncertainty.
- Ask instead of guessing.

---

# Core Features

Version 0.1 includes only the following features.

## Transaction Logging

Receive text messages.

Receive voice notes.

Extract transaction details.

Create a draft.

Wait for approval.

Save after confirmation.

---

## Bookkeeping Queries

Answer questions using stored records.

Examples:

How much have I spent this month?

How much rent has Apartment 2 generated?

Show my last five transactions.

How much have I spent on repairs?

---

## Monthly Statements

Generate a PDF containing:

Property name

Reporting period

Income

Expenses grouped by category

Total income

Total expenses

Net amount

Itemized transactions

The PDF is sent back through WhatsApp.

The user manually reviews it before forwarding it to the investor.

---

# User Flow

Transaction

User

↓

WhatsApp

↓

Webhook

↓

Voice transcription (if required)

↓

AI Classification

↓

AI Parsing

↓

Clarification (if needed)

↓

Draft Response

↓

User confirms

↓

Database

---

Question

User

↓

WhatsApp

↓

Database

↓

AI formats answer

↓

WhatsApp reply

---

Statement

User requests statement

↓

Database

↓

PDF Generation

↓

WhatsApp document

---

# AI Behaviour Rules

The AI must always follow these rules.

1. Never guess.

2. Never save automatically.

3. Never fabricate accounting information.

4. Always ask one clarification question if information is missing.

5. Keep replies short.

6. Lead with numbers.

7. Never use stored knowledge outside the database when answering bookkeeping questions.

8. Never modify previous transactions without explicit user instruction.

9. Always prefer clarification over assumption.

---

# Confirmation Rules

Every transaction follows this flow.

Draft

↓

User replies YES

↓

Save

OR

User provides correction

↓

Update draft

↓

Ask for confirmation again

---

# Corrections

The assistant should support:

Edit last transaction

Undo last transaction

Delete last transaction

Correct individual fields without restarting the entire draft.

---

# Duplicate Detection

If a transaction looks almost identical to one saved recently, the assistant should ask:

"This looks similar to a transaction you recently logged. Save another one?"

---

# Scope

Version 0.1 includes only:

One user

Known properties

Manual bookkeeping

WhatsApp

Voice notes

Text messages

Bookkeeping questions

PDF statements

Nothing else.

---

# Out Of Scope

Do NOT build:

Multi-user support

Dashboards

Authentication

Subscriptions

Payments

Bank integrations

Receipt OCR

Analytics

Investor portals

Recurring reports

Notifications

Mobile apps

Web applications

---

# Success Criteria

Version 0.1 is successful if:

The user prefers it over spreadsheets.

The user trusts the saved data.

Monthly reports require little manual correction.

The user says they would pay for it.

---

# Engineering Rule

Whenever there is a choice between:

More features

OR

Greater reliability

Choose reliability.

Whenever there is a choice between:

Automation

OR

Accuracy

Choose accuracy.

This project exists to build trust, not impress users with AI.