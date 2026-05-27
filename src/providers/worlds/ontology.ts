export const RDF = Object.freeze({
  _iri: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  type: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  Statement: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Statement",
} as const)

export const RDFS = Object.freeze({
  _iri: "http://www.w3.org/2000/01/rdf-schema#",
  label: "http://www.w3.org/2000/01/rdf-schema#label",
  comment: "http://www.w3.org/2000/01/rdf-schema#comment",
  subClassOf: "http://www.w3.org/2000/01/rdf-schema#subClassOf",
} as const)

export const OWL = Object.freeze({
  _iri: "http://www.w3.org/2002/07/owl#",
  Class: "http://www.w3.org/2002/07/owl#Class",
  NamedIndividual: "http://www.w3.org/2002/07/owl#NamedIndividual",
} as const)

export const XSD = Object.freeze({
  _iri: "http://www.w3.org/2001/XMLSchema#",
  string: "http://www.w3.org/2001/XMLSchema#string",
  integer: "http://www.w3.org/2001/XMLSchema#integer",
  dateTime: "http://www.w3.org/2001/XMLSchema#dateTime",
  boolean: "http://www.w3.org/2001/XMLSchema#boolean",
} as const)

export const SCHEMA = Object.freeze({
  _iri: "http://schema.org/",
  Conversation: "http://schema.org/Conversation",
  Message: "http://schema.org/Message",
  text: "http://schema.org/text",
  dateCreated: "http://schema.org/dateCreated",
  position: "http://schema.org/position",
  author: "http://schema.org/author",
  creator: "http://schema.org/creator",
  hasPart: "http://schema.org/hasPart",
} as const)

export const PROV = Object.freeze({
  _iri: "http://www.w3.org/ns/prov#",
  Activity: "http://www.w3.org/ns/prov#Activity",
  Entity: "http://www.w3.org/ns/prov#Entity",
  wasGeneratedBy: "http://www.w3.org/ns/prov#wasGeneratedBy",
  wasDerivedFrom: "http://www.w3.org/ns/prov#wasDerivedFrom",
  atTime: "http://www.w3.org/ns/prov#atTime",
  wasAttributedTo: "http://www.w3.org/ns/prov#wasAttributedTo",
} as const)

export const SKOS = Object.freeze({
  _iri: "http://www.w3.org/2004/02/skos/core#",
  Concept: "http://www.w3.org/2004/02/skos/core#Concept",
  prefLabel: "http://www.w3.org/2004/02/skos/core#prefLabel",
} as const)

export const WORLDS = Object.freeze({
  _iri: "https://worlds.wazoo.dev/ns/memory#",
  // Structural metadata
  claimType: "https://worlds.wazoo.dev/ns/memory#claimType",
  confidence: "https://worlds.wazoo.dev/ns/memory#confidence",
  sourceSpan: "https://worlds.wazoo.dev/ns/memory#sourceSpan",
  speakerA: "https://worlds.wazoo.dev/ns/memory#speakerA",
  speakerB: "https://worlds.wazoo.dev/ns/memory#speakerB",
  // Fact claim classes
  Claim: "https://worlds.wazoo.dev/ns/memory#Claim",
  FactClaim: "https://worlds.wazoo.dev/ns/memory#FactClaim",
  EventClaim: "https://worlds.wazoo.dev/ns/memory#EventClaim",
  PreferenceClaim: "https://worlds.wazoo.dev/ns/memory#PreferenceClaim",
  RelationshipClaim: "https://worlds.wazoo.dev/ns/memory#RelationshipClaim",
  PlanClaim: "https://worlds.wazoo.dev/ns/memory#PlanClaim",
  // Fact claim predicates
  claimSubject: "https://worlds.wazoo.dev/ns/memory#claimSubject",
  claimAction: "https://worlds.wazoo.dev/ns/memory#claimAction",
  claimObject: "https://worlds.wazoo.dev/ns/memory#claimObject",
  claimText: "https://worlds.wazoo.dev/ns/memory#claimText",
  claimWhen: "https://worlds.wazoo.dev/ns/memory#claimWhen",
  claimWhere: "https://worlds.wazoo.dev/ns/memory#claimWhere",
} as const)

export const TURTLE_PREFIXES = [
  `@prefix rdf: <${RDF._iri}> .`,
  `@prefix rdfs: <${RDFS._iri}> .`,
  `@prefix owl: <${OWL._iri}> .`,
  `@prefix xsd: <${XSD._iri}> .`,
  `@prefix schema: <${SCHEMA._iri}> .`,
  `@prefix prov: <${PROV._iri}> .`,
  `@prefix skos: <${SKOS._iri}> .`,
  `@prefix worlds: <${WORLDS._iri}> .`,
].join("\n")
