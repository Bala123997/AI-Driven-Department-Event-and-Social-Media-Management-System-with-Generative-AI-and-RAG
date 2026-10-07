# RAG Evaluation

Run `npm run rag:evaluate` with MySQL, ChromaDB, and the configured Ollama model available. The script reads approved events in each question's calendar scope, embeds each question, retrieves at most `RAG_TOP_K` records, and builds the answer context only from those retrieved IDs that also exist in the approved SQL result set.

The labeled cases are in `tests/fixtures/rag-evaluation.json`. `relevantTitleContains` identifies relevant event records by case-insensitive title substring, so update the labels when the event data changes. Cases whose labeled event is absent or outside the requested date scope are reported as skipped and are not scored.

Retrieval reports Precision@K, Recall@K, and Mean Reciprocal Rank (MRR). Answer quality is scored from 1 to 5 by the configured local Ollama model for faithfulness to retrieved evidence and relevance to the question. The judge scores are useful diagnostics, not a substitute for human review or a fixed reference-answer benchmark.

Calendar list, count, event-type, and registration-status questions use deterministic SQL-backed answers and do not invoke the LLM. The Top-K constraint applies to every generated LLM answer; direct list/count answers intentionally use all matching records to remain complete.