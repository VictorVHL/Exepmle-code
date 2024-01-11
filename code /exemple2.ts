import express, {Request, Response} from 'express';

import { BadRequestError, CustomError, CustomersNetworkManager, getBoolean, PageToken, UserRole, validatePagePermissions } from '@cherrypie/feedc.common';
import { IPost, Post } from '../../entities/mongodb/Post';
import { FeedEntity } from '../../entities/FeedEntity';
import { FeedFilterType } from '../../models/enums/FeedFilterType';
import { Operator } from '../../models/enums/Operator';
import { SortOrder } from '../../models/enums/SortOrder';
import { DateFilterValue } from '../../models/enums/DateFilterValue';
import moment from 'moment';
import { PostStatus } from '../../models/enums/PostStatus';
import { FeedFilter } from '../../models/feed/FeedFilter';
import { Category } from '../../entities/mongodb/Category';
import { getPostsByCategories, getPostsByCategory } from '../../services/PostCategoryManager';

const router = express.Router();

router.post(
    '/api/v4/pages/:pageId/feed/:feedId', 
    validatePagePermissions(true, true, true, [UserRole.ADMIN, UserRole.CREATOR]),
    async (req: Request, res: Response) => {
        const pageId: number = +req.params?.pageId!;
        let feedId: number = +req.params?.feedId!;
        const dynamicParams: { [key: string]: any; } = req.body.dynamicParams;
        const includeOwner: boolean = getBoolean(req.body.includeOwner);
        let usedPostIds: string[] = [];
        let pageToken: PageToken | undefined;

        try {
            if (req.body.pageToken != undefined){
                pageToken = PageToken.parse(req.body.pageToken.toString());
            }
            else if (req.query?.pageToken != undefined){
                pageToken = PageToken.parse(req.query.pageToken.toString());
            }    
        }
        catch (err){}

        if (pageToken && pageToken.feedId != undefined){
            feedId = pageToken.feedId;
        }

        if (pageToken && pageToken.usedIds != undefined && pageToken.usedIds.length>0){
            usedPostIds = pageToken.usedIds;
        }
        if(dynamicParams && dynamicParams.usedPostIds != undefined && dynamicParams.usedPostIds.length >0) {
            if(usedPostIds.length == 0) {
            usedPostIds = dynamicParams.usedPostIds;
            } else {
                dynamicParams.usedPostIds.map((id: string) => usedPostIds.push(id));
            }
        }

        let pageSize = (pageToken!=undefined) ? pageToken.pageSize : 15;
        let pageIndex = (pageToken!=undefined) ? (pageToken.pageIndex+1) : 0;

        const posts: IPost[] = [];
        if (pageId == 1 && pageToken == undefined && (feedId==1 || feedId==2 || feedId==5 || feedId==6)){

            const tmpPostType = feedId==5 ? 5 : 1;

            const pinPosts = await getPinPosts(pageId, tmpPostType);
            if (pinPosts && pinPosts.length>0){
                for (const pinPost of pinPosts) {
                    posts.push(pinPost);
                    usedPostIds.push(pinPost.id);                        
                }
            }
        }

        const feedResponse: FeedResponse = await getFeed(feedId, pageId, usedPostIds, dynamicParams, pageSize, pageIndex);
        for (let post of feedResponse.posts) {
            usedPostIds.push(post.id);
        }
        const newPageTokenFeedId = feedResponse.newPageTokenFeedId;
        let hasMore = feedResponse.hasMore;
        // posts = feedResponse.posts;
        for (let post of feedResponse.posts) {
            posts.push(post);
        }

        if (pageId == 1 && feedId != newPageTokenFeedId && posts.length<7 && hasMore){
            //FEEDC

            const feedResponse: FeedResponse = await getFeed(newPageTokenFeedId, pageId, usedPostIds, dynamicParams, pageSize, pageIndex);
            for (let post of feedResponse.posts) {
                usedPostIds.push(post.id);
            }
            hasMore = feedResponse.hasMore;

            for (let post of feedResponse.posts) {
                posts.push(post);
            }
        }


        if (includeOwner){
            const customersIds: string[] = [];
            for (const post of posts) {
                if (!customersIds.includes(post.ownerId)){
                    customersIds.push(post.ownerId);
                }
            }
            if (customersIds.length > 0){
                const customers = await CustomersNetworkManager.getCustomers(pageId, customersIds, req.accessTokenString!);
    
                for (let post of posts) {
                    for (const customer of customers) {
                        if (post.ownerId == customer.id){
                            post.owner = customer;
                        }
                    }
                }
            }
        }

        if (posts.length > 0){
           const categories = await Category.find();
                for (let post of posts) {
                    for (const category of categories) {
                        if(post.properties[37] != undefined){
                          if(post.properties[37].value[category.id] == true) {
                            post.properties[37].value[category.id] = category;
                          }
                        }
                    }
                }
        }

        const newPageToken: PageToken = new PageToken(0, pageSize);
        newPageToken.feedId = newPageTokenFeedId;
        newPageToken.usedIds = usedPostIds;
        const response = {
            hasMore: hasMore,
            pageToken: newPageToken,
            posts: posts
        };

        res.status(200).send(response);
    }
);

interface FeedResponse {
    hasMore: boolean;
    newPageTokenFeedId: number;
    posts: IPost[];
}

async function getPinPosts(pageId: number, postType: number) : Promise<IPost[]>{
    const pinPosts = await Post.find()
        .where('pageId').equals(pageId)
        .where('postType').equals(postType)
        .where('status').equals(PostStatus.ACTIVE)
        .where('pinned').equals(true);

    return pinPosts;
}

async function getFeed(feedId: number, pageId: number, usedPostIds: string[], dynamicParams: { [key: string]: any; }, pageSize: number, pageIndex: number) : Promise<FeedResponse>{
    let newPageTokenFeedId = feedId;

    const feed = await FeedEntity.findOne(feedId);
    if (!feed || feed.pageId != pageId){
        throw new BadRequestError('Feed not found');
    }

    const feedRule = feed.getPrimaryRule();
    
    let posts: IPost[] = [];
    if (feedRule){
        try {
            let postsQuery = Post.find();
            postsQuery = postsQuery.where('pageId').equals(pageId);
            postsQuery = postsQuery.where('postType').equals(feed.postType);
            postsQuery = postsQuery.where('status').equals(PostStatus.ACTIVE);

            if (usedPostIds.length > 0){
                postsQuery = postsQuery.where('_id').nin(usedPostIds);
            }

            let filtersQuery = [];
            if (feedRule.filters && feedRule.filters.length>0){
                for (const filter of feedRule.filters) {
                    let filterValue:any = filter.value;

                    if (dynamicParams && filterValue!=undefined){
                        for (const key in dynamicParams) {
                            if (Object.prototype.hasOwnProperty.call(dynamicParams, key)) {
                                const element = dynamicParams[key];
                                
                                filterValue = filterValue.split(`{{${key}}}`).join(element)                                    
                            }
                        }    
                    }

                    if (filter.propertyId){
                        let qq: { [key: string]: any; } = {};

                        const propertyKey = `properties.${filter.propertyId}`;
                        const valueKey = `properties.${filter.propertyId}.value`;

                        const isDate = filterValue!=undefined && (<any>Object).values(DateFilterValue).includes(filterValue);

                        const isBoolean = filterValue=='true' || filterValue=='false';
                        if (isBoolean){
                            filterValue = getBoolean(filterValue);
                        }

                        let fromTimestamp: number = 0;
                        let toTimestamp: number = 0;

                        if (filter.operator == Operator.EQUALS){
                            if (isDate){

                                if (filterValue == DateFilterValue.LAST_30_MINUTES){
                                    fromTimestamp = moment().subtract(30, 'minutes').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_HOUR){
                                    fromTimestamp = moment().subtract(1, 'hour').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_24_HOURS){
                                    fromTimestamp = moment().subtract(24, 'hour').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_2_DAYS){
                                    fromTimestamp = moment().subtract(2, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_3_DAYS){
                                    fromTimestamp = moment().subtract(3, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_7_DAYS){
                                    fromTimestamp = moment().subtract(7, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_30_DAYS){
                                    fromTimestamp = moment().subtract(30, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_365_DAYS){
                                    fromTimestamp = moment().subtract(1, 'year').unix()
                                }
                                else if (filterValue == DateFilterValue.PREVIOUS_MONTH){
                                    const tmpMoment = moment().subtract(1, 'month');

                                    fromTimestamp = tmpMoment.startOf('month').unix()
                                    toTimestamp = tmpMoment.endOf('month').unix()
                                }
                                else if (filterValue == DateFilterValue.CURRENT_MONTH){
                                    fromTimestamp = moment().startOf('month').unix()
                                }
                                else if (filterValue == DateFilterValue.PREVIOUS_WEEK){
                                    const tmpMoment = moment().subtract(1, 'week');

                                    fromTimestamp = tmpMoment.startOf('week').unix()
                                    toTimestamp = tmpMoment.endOf('week').unix()
                                }
                                else if (filterValue == DateFilterValue.CURRENT_WEEK){
                                    fromTimestamp = moment().startOf('week').unix()
                                }
                            }
                            else{
                                qq[valueKey] = filterValue;
                            }
                        }
                        else if (filter.operator == Operator.NOT_EQUALS){
                            if (isDate){
                                if (filterValue == DateFilterValue.LAST_30_MINUTES){
                                    toTimestamp = moment().subtract(30, 'minutes').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_HOUR){
                                    toTimestamp = moment().subtract(1, 'hour').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_24_HOURS){
                                    toTimestamp = moment().subtract(24, 'hour').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_2_DAYS){
                                    toTimestamp = moment().subtract(2, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_3_DAYS){
                                    toTimestamp = moment().subtract(3, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_7_DAYS){
                                    toTimestamp = moment().subtract(7, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_30_DAYS){
                                    toTimestamp = moment().subtract(30, 'days').unix()
                                }
                                else if (filterValue == DateFilterValue.LAST_365_DAYS){
                                    toTimestamp = moment().subtract(1, 'year').unix()
                                }
                                else if (filterValue == DateFilterValue.PREVIOUS_MONTH){
                                    // TODO: bug here. 
                                    // it should also show posts from CURRENT MONTH. 
                                    // But it shows only EARLIER THAN PREVIOUS MONTH
                                    toTimestamp = moment().subtract(1, 'month').startOf('month').unix()
                                }
                                else if (filterValue == DateFilterValue.CURRENT_MONTH){
                                    toTimestamp = moment().startOf('month').unix()
                                }
                                else if (filterValue == DateFilterValue.PREVIOUS_WEEK){
                                    // TODO: BUG here. 
                                    // it should also show posts from CURRENT WEEK. 
                                    // But it shows only EARLIER THAN PREVIOUS WEEK
                                    toTimestamp = moment().subtract(1, 'week').startOf('week').unix()
                                }
                                else if (filterValue == DateFilterValue.CURRENT_WEEK){
                                    toTimestamp = moment().startOf('week').unix()
                                }
                            }
                            else{
                                qq[valueKey] = { $ne: filterValue }
                            }
                        }
                        else if (filter.operator == Operator.CONTAINS){
                            qq[valueKey] = { $regex: filterValue, $options: 'i' }
                        }
                        else if (filter.operator == Operator.LESS){
                            qq[valueKey] = { $lt: filterValue };
                        }
                        else if (filter.operator == Operator.LESS_OR_EQUALS){
                            qq[valueKey] = { $lte: filterValue };
                        }
                        else if (filter.operator == Operator.MORE){
                            qq[valueKey] = { $gt: filterValue };
                        }
                        else if (filter.operator == Operator.MORE_OR_EQUALS){
                            qq[valueKey] = { $gte: filterValue };
                        }
                        else if (filter.operator == Operator.IS_NULL){
                            qq[propertyKey] = { $exists: false };
                        }
                        else if (filter.operator == Operator.IS_NOT_NULL){
                            qq[propertyKey] = { $exists: true };
                        }
                        else{
                            throw new BadRequestError('Feed settings are broken');
                        }

                        if (isDate){
                            if (fromTimestamp > 0 && toTimestamp > 0){
                                qq[valueKey] = { $gte: fromTimestamp, $lte: toTimestamp };
                            }
                            else if (fromTimestamp > 0){
                                qq[valueKey] = { $gte: fromTimestamp };
                            }
                            else if (toTimestamp > 0){
                                qq[valueKey] = { $lte: toTimestamp };
                            }
                        }

                        filtersQuery.push(qq);
                    }
                }    
            }

            if (pageId == 1 && feedId == 14 || feedId == 18 || feedId == 27 ){
                postsQuery.where({ 'properties.31.value':  { $ne: true } })
             }
            if (pageId == 1 && feedId == 18){
                const fromTimestamp = moment().subtract(24, 'hour').unix()
                postsQuery.where({ 'properties.7.value':  { $gte: fromTimestamp } })
             }
             if (pageId == 1 && feedId == 14){
               const toTimestamp = moment().subtract(24, 'hour').unix()
                postsQuery.where({ 'properties.7.value':  { $lte: toTimestamp } })
             }
             if (pageId == 1 && feedId == 27){
                const countryCode = filtersQuery[0]['properties.1.value']
                 postsQuery.where({ 'properties.1.value':  countryCode})
                 filtersQuery.push({ 'properties.35': undefined})
                 filtersQuery.shift();
              }

            if (pageId == 1 && feedId == 29){
                const categoryId = filtersQuery[0]['properties.37.value']
                let postIds : string[] = [];
                postIds = await getPostsByCategory(categoryId, pageSize, pageIndex);
                if (postIds.length < 1 && pageIndex == 0) {
                    const category = await Category.findById(categoryId);
                    if (category && category.similarCategories && category.similarCategories.length > 0) {
                        postIds = await getPostsByCategories(category?.similarCategories!, pageSize, pageIndex)
                    }
                }
                postsQuery.where('_id').in(postIds);
                filtersQuery.shift();
              }

            if (filtersQuery.length > 0){
                if (feedRule.filterType == FeedFilterType.OR){
                    postsQuery.or(filtersQuery);
                }
                else{
                    postsQuery.and(filtersQuery);
                }    
            }

            if (feedRule.sorting){
                let ss: { [key: string]: any; } = {};
                ss[`properties.${feedRule.sorting.propertyId}.value`] = (feedRule.sorting.order == SortOrder.ASC) ? 1 : -1;
                postsQuery.sort(ss);
            }

            posts = await postsQuery.limit(pageSize+1).exec();
        } catch (err) {
            if (err instanceof CustomError) {
                throw err;
            }
            else{
                throw new BadRequestError('Bad request');
            }
        }    
    }

    let hasMore = false;
    if (posts.length > pageSize){
        hasMore = true;
        posts.splice(-1, 1);
    }

    if (pageId == 1){
        // FEEDC

        if (hasMore == false){
            if (feedId == 1){
                // if world feed, we add other feed (by timestamp)
                newPageTokenFeedId = 8;
                hasMore = true;
            }
            else if (feedId == 2){
                // if local feed, we add other feed (by timestamp)
                newPageTokenFeedId = 9;
                hasMore = true;
            }
            else if (feedId == 18){
                // if local feed, we add other feed (by timestamp)
                newPageTokenFeedId = 14;
                hasMore = true;
            }
            else if (feedId == 17){
                // if local feed, we add other feed (by timestamp)
                newPageTokenFeedId = 24;
                hasMore = true;
            }
        }
    }

    const resp: FeedResponse = {
        hasMore: hasMore,
        newPageTokenFeedId: newPageTokenFeedId,
        posts: posts
    }

    return resp;
}

export { router as feedRouterV4 };