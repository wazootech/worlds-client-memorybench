import { RDF, SCHEMA, PROV, WORLDS, XSD, TURTLE_PREFIXES } from "./ontology"

/**
 * SHACL shapes for validating the session/message graph produced by
 * formatSessionForIngestion(). Expressed as Turtle so they can be loaded
 * into any SHACL engine. For Phase 1, validation is structural (regex
 * walking over the Turtle output) rather than full SHACL engine evaluation.
 */

export const SESSION_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:SessionShape a sh:NodeShape ;
  sh:targetClass schema:Conversation ;
  sh:property [
    sh:path schema:dateCreated ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string ;
  ] ;
  sh:property [
    sh:path schema:hasPart ;
    sh:minCount 1 ;
    sh:node worlds:MessageShape ;
  ] .
`

export const MESSAGE_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:MessageShape a sh:NodeShape ;
  sh:targetClass schema:Message ;
  sh:property [
    sh:path schema:text ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string ;
  ] ;
  sh:property [
    sh:path schema:position ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:integer ;
  ] ;
  sh:property [
    sh:path schema:author ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
  ] ;
  sh:property [
    sh:path prov:wasGeneratedBy ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
  ] .
`

export const CLAIM_SHAPE = `
${TURTLE_PREFIXES}
@prefix sh: <http://www.w3.org/ns/shacl#> .

worlds:ClaimShape a sh:NodeShape ;
  sh:targetClass prov:Entity ;
  sh:property [
    sh:path worlds:claimType ;
    sh:minCount 1 ;
  ] .
`

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Structural validation of a Turtle document against the session/message
 * shapes. This is a lightweight check — it verifies that required triples
 * are present by scanning the serialized output, not by running a full
 * SHACL engine. A full SHACL engine can be wired in when the graph grows
 * complex enough to justify the dependency.
 */
export function validateGraph(turtle: string): ValidationResult {
  const errors: string[] = []

  const hasSession = turtle.includes(SCHEMA.Conversation)
  if (!hasSession) {
    errors.push(`Missing session type: expected <${SCHEMA.Conversation}>`)
  }

  const hasDateCreated = turtle.includes(SCHEMA.dateCreated)
  if (!hasDateCreated) {
    errors.push(`Missing session date: expected <${SCHEMA.dateCreated}>`)
  }

  const hasMessage = turtle.includes(SCHEMA.Message)
  if (!hasMessage) {
    errors.push(`Missing message type: expected <${SCHEMA.Message}>`)
  }

  const hasText = turtle.includes(SCHEMA.text)
  if (!hasText) {
    errors.push(`Missing message text: expected <${SCHEMA.text}>`)
  }

  const hasPosition = turtle.includes(SCHEMA.position)
  if (!hasPosition) {
    errors.push(`Missing message position: expected <${SCHEMA.position}>`)
  }

  const hasAuthor = turtle.includes(SCHEMA.author)
  if (!hasAuthor) {
    errors.push(`Missing message author: expected <${SCHEMA.author}>`)
  }

  const hasHasPart = turtle.includes(SCHEMA.hasPart)
  if (!hasHasPart) {
    errors.push(`Missing session-to-message link: expected <${SCHEMA.hasPart}>`)
  }

  const hasProvenance = turtle.includes(PROV.wasGeneratedBy)
  if (!hasProvenance) {
    errors.push(`Missing provenance link: expected <${PROV.wasGeneratedBy}>`)
  }

  return { valid: errors.length === 0, errors }
}
