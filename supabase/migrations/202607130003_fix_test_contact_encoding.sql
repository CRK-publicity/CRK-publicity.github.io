-- Correct the encoding of the technical test contact created during validation.
update public.contacts
set full_name = 'Prueba técnica CRK'
where phone_e164 = '+573028402389'
  and full_name like 'Prueba%cnica CRK';
