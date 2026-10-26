-- PDF text is saved as immutable, page-addressed source parts. Existing source
-- rows and exact quote provenance remain unchanged; no PDF bytes or OCR claims
-- are stored in this table.
alter table unfurl.research_source_documents
  drop constraint research_source_documents_media_type_check;
alter table unfurl.research_source_documents
  add constraint research_source_documents_media_type_check check (
    media_type in ('text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json', 'application/pdf')
  );
alter table unfurl.research_source_documents add column pdf_part jsonb;
alter table unfurl.research_source_documents
  add constraint research_source_pdf_part_check check (
    (media_type = 'application/pdf') = (pdf_part is not null)
    and (pdf_part is null or (
      extractor_version = 'pdfjs-6.4.299-text-v1'
      and jsonb_typeof(pdf_part) = 'object'
      and pdf_part ?& array['kind', 'totalPages', 'start', 'end', 'next']
      and octet_length(pdf_part::text) <= 16384
      and pdf_part->>'kind' = 'pdf-text-v1'
      and jsonb_typeof(pdf_part->'totalPages') = 'number'
      and (pdf_part->>'totalPages')::numeric > 0
      and jsonb_typeof(pdf_part->'start') = 'object'
      and jsonb_typeof(pdf_part->'end') = 'object'
      and pdf_part ? 'next'
      and (pdf_part->'next' = 'null'::jsonb or (
        jsonb_typeof(pdf_part->'next') = 'object'
        and pdf_part->'next'->>'kind' = 'pdf-text-v1'
        and pdf_part->'next'->>'rawDigest' = raw_digest
        and pdf_part->'next'->>'extractorVersion' = extractor_version
        and pdf_part->'next'->'totalPages' = pdf_part->'totalPages'
      ))
    ))
  );
