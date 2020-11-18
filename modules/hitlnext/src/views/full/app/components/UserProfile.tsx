import { Collapsible, lang } from 'botpress/shared'
import _ from 'lodash'
import React, { FC, Fragment, useContext, useEffect, useState } from 'react'

import { IUser } from '../../../../types'
import style from '../../style.scss'
import { Context } from '../Store'

import { generateUsername, getOrSet } from './../utils'

const UserProfile: FC<IUser> = props => {
  const { state, dispatch } = useContext(Context)

  const [expanded, setExpanded] = useState(true)
  const [defaultUsername, setDefaultUsername] = useState<string>()

  useEffect(() => {
    const key = props.id
    const username = getOrSet(
      () => {
        return _.get(state, `defaults.user.${key}.username`)
      },
      value => {
        dispatch({
          type: 'setDefault',
          payload: {
            user: {
              [key]: {
                username: value
              }
            }
          }
        })
      },
      generateUsername()
    )

    setDefaultUsername(username)
  }, [props.id])

  const userName = () => {
    return (!_.isEmpty(props.attributes) && props.attributes['fullName']) || state.config.defaultUsername
      ? defaultUsername
      : lang.tr('module.hitlnext.user.anonymous')
  }

  return (
    <div>
      <div className={style.profileHeader}>
        <span className={style.clientName}>{userName()}</span>
        {!_.isEmpty(props.attributes) && props.attributes['email'] && <p>{props.attributes['email']}</p>}
      </div>

      {!_.isEmpty(props.attributes) && (
        <Fragment>
          <div className={style.divider}></div>
          <Collapsible
            opened={expanded}
            toggleExpand={() => setExpanded(!expanded)}
            name={lang.tr('module.hitlnext.user.variables.heading')}
          >
            <table className={style.table}>
              <thead>
                <tr>
                  <th>{lang.tr('module.hitlnext.user.variables.variable')}</th>
                  <th>{lang.tr('module.hitlnext.user.variables.value')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(props.attributes).map((entry, index) => (
                  <tr key={index}>
                    <td>{entry[0]}</td>
                    <td>{entry[1]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Collapsible>
        </Fragment>
      )}
    </div>
  )
}

export default UserProfile
