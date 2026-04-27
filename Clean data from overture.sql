	install httpfs; 
	load httpfs;
	install spatial;
	load spatial;


	SET s3_region='us-west-2';

	SET VARIABLE latestver = (
		SELECT latest FROM 'https://stac.overturemaps.org/catalog.json'
	);

	SELECT getvariable('latestver') AS current_release; -- Show that the latest version is correct

	set variable aws = ('s3://overturemaps-us-west-2/release/' || getvariable('latestver') || '/theme=places/type=place/*.parquet');

	SELECT getvariable('aws') AS current_release; -- SHow the full url to get the latest data from overture maps

	CREATE TABLE places AS SELECT -- Gather all places from overture maps
		id, geometry, categories, websites, emails, phones, addresses, names, operating_status, basic_category, taxonomy, bbox
		FROM read_parquet(getvariable('aws'))
		WHERE bbox.xmin BETWEEN 4.350586 AND 31.293418
		AND bbox.ymin BETWEEN 57.914848 AND  80.657144;


	CREATE TABLE garder AS --Tabell for alle gårder som skal produsere mat
	select * from places
	where categories.primary like '%farm%'
	  and regexp_matches(
			coalesce(lower(trim(taxonomy.primary)), ''),
			'(farm|orchard|vineyard|dairy|poultry|livestock|cattle|sheep|goat|pig|swine|aquaculture|apiary|greenhouse|vegetable|fruit)'
		  )
	  and not regexp_matches(
			coalesce(lower(trim(taxonomy.primary)), ''),
			'(urban_farm|farmers_market|farmes_market|farming_service|wind_farm|solar_farm|horse|equestrian)'
		  )
	  and exists (

		select 1
		from unnest(addresses) as a(address)
		where address.country = 'NO'
	); 

	CREATE TABLE vannkilder AS -- Tabell for alle drikkevannkilder. 
	select * from places where categories.primary like '%water%'
	AND taxonomy.primary IN ('water_treatment_equipment_and_service', 'water_utility_provider')
	AND exists (
		select 1
		from unnest(addresses) as a(address)
		where address.country = 'NO'
	); 

	CREATE TABLE legevakter AS -- Tabell for legevakter
	select * from places where lower(names.primary) like '%legevakt%' AND lower(names.primary) not like '%tannlege%'; 



CREATE TABLE sykehus AS -- Lager en filtrert tabell for sykehus i norge (ikke 100% nøyaktig)
with hospital_candidates as (
	select
		p.*,
		regexp_replace(
			lower(trim(coalesce(p.names.primary, ''))),
			'\\s*[-,()]?\\s*(avdeling|klinikk|seksjon|enhet|post|poliklinikk|akuttmottak|laboratorium|lab|radiologi|kirurgi|medisin).*$',
			''
		) as hospital_key,
		coalesce((
			select min(lower(address.locality))
			from unnest(p.addresses) as a(address)
		), '') as locality_key
	from places p
	where regexp_matches(lower(coalesce(p.names.primary, '')), '(sykehus|sjukehus)')
	  and not regexp_matches(lower(coalesce(p.names.primary, '')), 'dyr')
	  and (
			contains(lower(coalesce(p.basic_category, '')), 'hospital')
			or contains(lower(coalesce(p.taxonomy.primary, '')), 'hospital')
	  )
), ranked_hospitals as (
	select
		*,
		row_number() over (
			partition by hospital_key, locality_key
			order by length(coalesce(names.primary, '')), coalesce(id, '')
		) as rn
	from hospital_candidates
)
select * exclude (hospital_key, locality_key, rn)
from ranked_hospitals
where rn = 1;